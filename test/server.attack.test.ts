import { spawn } from "node:child_process";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { expect, test } from "vitest";
import { createServer } from "../src/server.js";
import {
  code,
  cookieValue,
  csrfToken,
  env,
  fakeFetch,
  json,
  loginAnswers,
  secrets,
} from "./fake-fetch.js";

async function connectClient(
  deps: Parameters<typeof createServer>[0],
): Promise<Client> {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await createServer(deps).connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

async function call(client: Client, name: string, args: unknown = {}) {
  const result = await client.callTool({
    name,
    arguments: args as Record<string, unknown>,
  });
  const [content] = result.content as { type: string; text: string }[];
  return { isError: result.isError ?? false, text: content?.text ?? "" };
}

function expectNoSecrets(text: string): void {
  for (const secret of secrets) expect(text).not.toContain(secret);
}

test.each([
  ["a number", 123456],
  ["an empty string", ""],
  ["a trailing newline", "123456\n"],
  ["a trailing space", "123456 "],
  ["an inner space", "123 456"],
  ["a negative number", "-12345"],
  ["Arabic-Indic digits", "٩١٨٢٧٣"],
  ["null", null],
])("ct_login rejects %s as the code before any request", async (_, bad) => {
  const { fetch, calls } = fakeFetch();
  const client = await connectClient({ env, fetch });

  const { isError } = await call(client, "ct_login", { code: bad });

  expect(isError).toBe(true);
  expect(calls).toHaveLength(0);
});

test("ct_login without a code logs in when the account has no 2FA", async () => {
  const { fetch, calls } = fakeFetch(...loginAnswers("success"));
  const client = await connectClient({ env, fetch });

  const { isError, text } = await call(client, "ct_login", {});

  expect(isError).toBe(false);
  expect(text).toContain('"state":"ready"');
  expect(calls.map((c) => c.path)).not.toContain("/churchtools/api/login/totp");
});

test("ct_login accepts a code with a leading zero", async () => {
  const { fetch, calls } = fakeFetch(...loginAnswers());
  const client = await connectClient({ env, fetch });

  const { isError } = await call(client, "ct_login", { code: "000000" });

  expect(isError).toBe(false);
  expect(calls[1]?.body).toEqual({ code: "000000", personId: 7 });
});

test("a wrong password through ct_login is an error result without secrets", async () => {
  const { fetch } = fakeFetch(
    json(
      { message: `Wrong password ${env.CT_PASSWORD}`, args: [] },
      { status: 400 },
    ),
  );
  const client = await connectClient({ env, fetch });

  const { isError, text } = await call(client, "ct_login", { code });

  expect(isError).toBe(true);
  expect(JSON.parse(text)).toMatchObject({
    error: expect.stringContaining("Wrong password") as unknown,
  });
  expectNoSecrets(text);
});

test("a network error mid-login is an error result, and a second ct_login succeeds", async () => {
  const answers = [...loginAnswers(), ...loginAnswers()];
  let n = 0;
  const fetch: typeof globalThis.fetch = () =>
    n++ === 1
      ? Promise.reject(new TypeError("fetch failed"))
      : Promise.resolve(answers.shift() as Response);
  const client = await connectClient({ env, fetch });

  const first = await call(client, "ct_login", { code });
  answers.splice(0, 3); // the unused totp, whoami and csrftoken of the first login
  const second = await call(client, "ct_login", { code });

  expect(first).toMatchObject({ isError: true });
  expect(first.text).toContain("fetch failed");
  expect(second).toMatchObject({ isError: false });
  expect(JSON.parse(second.text)).toMatchObject({ state: "ready" });
});

test("concurrent ct_login calls both answer and never leak secrets", async () => {
  const { fetch } = fakeFetch(...loginAnswers(), ...loginAnswers());
  const client = await connectClient({ env, fetch });

  const results = await Promise.all([
    call(client, "ct_login", { code }),
    call(client, "ct_login", { code }),
  ]);

  for (const { text } of results) expectNoSecrets(text);
});

// The built server over stdio

const preload = `data:text/javascript,${encodeURIComponent(`
const answers = {
  "/login": () => new Response(JSON.stringify({ data: { status: "totp", personId: 7 } }),
    { headers: { "content-type": "application/json", "set-cookie": "ChurchTools_ct=${cookieValue}; Path=/" } }),
  "/login/totp": () => Response.json({ data: { status: process.env.TOTP_STATUS } }),
  "/whoami": () => Response.json({ data: { id: 7, firstName: "Anna", lastName: "Admin" } }),
  "/csrftoken": () => Response.json({ data: "${csrfToken}" }),
};
globalThis.fetch = async (input) => {
  const path = new URL(String(input)).pathname.replace(/^.*\\/api/, "");
  return answers[path]();
};
`)}`;

function runBuiltServer(totpStatus: string): Promise<string> {
  const child = spawn(
    process.execPath,
    ["--import", preload, "dist/index.js"],
    { env: { ...env, TOTP_STATUS: totpStatus, PATH: process.env.PATH } },
  );
  let stdout = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  const send = (message: object) =>
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  send({
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "t", version: "0" },
    },
  });
  send({ method: "notifications/initialized" });
  send({
    id: 2,
    method: "tools/call",
    params: { name: "ct_login", arguments: { code } },
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`no answer to ct_login; stdout: ${stdout}`));
    }, 10_000);
    child.stdout.on("data", () => {
      if (!stdout.includes('"id":2')) return;
      clearTimeout(timer);
      child.kill();
      resolve(stdout);
    });
  });
}

test.each(["success", "failure"])(
  "the built server writes only JSON-RPC to stdout during a login (totp %s)",
  async (totpStatus) => {
    const stdout = await runBuiltServer(totpStatus);

    const lines = stdout.split("\n").filter((line) => line !== "");
    for (const line of lines) {
      expect(JSON.parse(line)).toMatchObject({ jsonrpc: "2.0" });
    }
    expect(lines).toHaveLength(2);
    expectNoSecrets(stdout);
  },
  30_000,
);
