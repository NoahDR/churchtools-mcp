import { execFileSync, spawn } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, test } from "vitest";

/** Starts the server the way Claude Code does: the `churchtools` entry of `.mcp.json`, from a copy of the built repository. */
const root = fileURLToPath(new URL("..", import.meta.url));
const entry = (
  JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8")) as {
    mcpServers: Record<string, { command: string; args: string[] }>;
  }
).mcpServers.churchtools;
const password = "dummy-pass-7Qx";
const dummyEnv = `CT_URL=https://example.invalid\nCT_USERNAME=dummy-user\nCT_PASSWORD=${password}\n`;

const copies: string[] = [];
afterAll(() => {
  for (const dir of copies) rmSync(dir, { recursive: true, force: true });
});

/** package.json, dist and a link to node_modules; `npm run build` comes first. */
function repoCopy(envFile?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "ct-mcp-start-"));
  copies.push(dir);
  cpSync(join(root, "package.json"), join(dir, "package.json"));
  cpSync(join(root, "dist"), join(dir, "dist"), { recursive: true });
  symlinkSync(join(root, "node_modules"), join(dir, "node_modules"), "dir");
  mkdirSync(join(dir, "sub", "deeper"), { recursive: true });
  if (envFile !== undefined) writeFileSync(join(dir, ".env"), envFile);
  return dir;
}

interface Run {
  messages: { id?: number; result?: unknown; error?: unknown }[];
  notJsonRpc: string[];
  stdout: string;
  stderr: string;
  exit: { code: number | null; signal: NodeJS.Signals | null } | "running";
}

/** Sends `calls` after the handshake, waits for every answer, then closes stdin and waits up to 5 s for the exit. */
async function start(
  cwd: string,
  calls: { name: string; arguments: object }[],
): Promise<Run> {
  const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };
  const child = spawn(entry.command, entry.args, { cwd, env });
  let stdout = "";
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const exited = new Promise<Run["exit"]>((resolve) =>
    child.on("exit", (code, signal) => resolve({ code, signal })),
  );
  const lastId = calls.length + 1;
  const answered = new Promise<void>((resolve) => {
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      const ids = parseLines(stdout).map((m) => m.id);
      if (
        Array.from({ length: lastId }, (_, i) => i + 1).every((id) =>
          ids.includes(id),
        )
      )
        resolve();
    });
  });
  const send = (message: object) =>
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  send({
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "tester", version: "0.0.0" },
    },
  });
  send({ method: "notifications/initialized" });
  calls.forEach((params, i) =>
    send({ id: i + 2, method: "tools/call", params }),
  );
  await Promise.race([answered, exited]);
  child.stdin.end();
  const exit = await Promise.race([
    exited,
    new Promise<"running">((resolve) =>
      setTimeout(() => resolve("running"), 5000),
    ),
  ]);
  if (exit === "running") child.kill("SIGKILL");
  const lines = stdout.split("\n").filter((line) => line !== "");
  return {
    messages: parseLines(stdout),
    notJsonRpc: lines.filter((line) => !isJsonRpc(line)),
    stdout,
    stderr,
    exit,
  };
}

function parseLines(text: string): Run["messages"] {
  return text
    .split("\n")
    .filter(isJsonRpc)
    .map((line) => JSON.parse(line) as Run["messages"][number]);
}

function isJsonRpc(line: string): boolean {
  try {
    return (JSON.parse(line) as { jsonrpc?: unknown }).jsonrpc === "2.0";
  } catch {
    return false;
  }
}

function toolText(run: Run, id: number): { isError?: boolean; body: unknown } {
  const result = run.messages.find((m) => m.id === id)?.result as {
    isError?: boolean;
    content: { text: string }[];
  };
  return {
    isError: result.isError,
    body: JSON.parse(result.content[0].text) as unknown,
  };
}

const statusAndLogin = [
  { name: "ct_status", arguments: {} },
  { name: "ct_login", arguments: { code: "123456" } },
];

test.each([
  ["the repository root", ""],
  ["a subdirectory", join("sub", "deeper")],
])(
  "the .mcp.json command started from %s reads the root .env and answers ct_status and ct_login with errors",
  async (_where, subdir) => {
    const dir = repoCopy(dummyEnv);

    const run = await start(join(dir, subdir), statusAndLogin);

    expect(toolText(run, 2)).toEqual({
      isError: undefined,
      body: {
        configValid: true,
        state: "logged_out",
        instance: { error: expect.any(String) as unknown },
      },
    });
    expect(toolText(run, 3)).toEqual({
      isError: true,
      body: { error: expect.stringMatching(/^Login failed: /) as unknown },
    });
  },
  30_000,
);

test("the .mcp.json command writes nothing but JSON-RPC to stdout and never the password", async () => {
  const run = await start(repoCopy(dummyEnv), statusAndLogin);

  expect(run.notJsonRpc).toEqual([]);
  expect(run.stdout).not.toContain(password);
  expect(run.stderr).not.toContain(password);
}, 30_000);

test("the .mcp.json command without .env reports the missing settings and keeps running", async () => {
  const run = await start(repoCopy(), statusAndLogin);

  expect(toolText(run, 2).body).toMatchObject({
    configValid: false,
    configError: expect.stringContaining("CT_URL is missing") as unknown,
  });
  expect(toolText(run, 3).isError).toBe(true);
  expect(run.notJsonRpc).toEqual([]);
}, 30_000);

test("closing stdin ends the server started by the .mcp.json command", async () => {
  const run = await start(repoCopy(dummyEnv), []);

  expect(run.exit).toEqual({ code: 0, signal: null });
}, 30_000);

test.each([
  ["garbage lines", "not an env file\n===\nCT_URL\n"],
  ["an http URL", dummyEnv.replace("https:", "http:")],
  [
    "the password inside the URL",
    dummyEnv.replace("https://", `https://dummy-user:${password}@`),
  ],
  [
    "the password as the URL",
    dummyEnv.replace(/CT_URL=.*/, `CT_URL=${password}`),
  ],
  ["an unterminated quote", dummyEnv.replace("CT_URL=", 'CT_URL="')],
])(
  "a .env with %s gives a configuration error without the password",
  async (_case, envFile) => {
    const run = await start(repoCopy(envFile), statusAndLogin);

    expect(toolText(run, 2).body).toMatchObject({ configValid: false });
    expect(toolText(run, 3).isError).toBe(true);
    expect(run.notJsonRpc).toEqual([]);
    expect(run.stdout + run.stderr).not.toContain(password);
  },
  30_000,
);

/** README: copy .env.example to .env and fill in the values. A password with `#` is common. */
test("a password with # filled into .env.example reaches the server unchanged", () => {
  const secret = "dummy#pass 1";
  const filled = readFileSync(join(root, ".env.example"), "utf8").replace(
    /^CT_PASSWORD=(["']?)\1$/m,
    (_line, quote: string) => `CT_PASSWORD=${quote}${secret}${quote}`,
  );
  const dir = repoCopy(filled);
  const script = (
    JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      scripts: { start: string };
    }
  ).scripts.start;
  const flags = script.split(" ").filter((part) => part.startsWith("--"));

  const loaded = execFileSync(
    process.execPath,
    [...flags, "-p", "process.env.CT_PASSWORD"],
    { cwd: dir, env: { PATH: process.env.PATH ?? "" }, encoding: "utf8" },
  );

  expect(loaded.trim()).toBe(secret);
});
