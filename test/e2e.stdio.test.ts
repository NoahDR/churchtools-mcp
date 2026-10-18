import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { expect, test } from "vitest";

/** The built server, started from the repository root without ChurchTools credentials; `npm run build` comes first. */
const server = {
  command: process.execPath,
  args: ["dist/index.js"],
  cwd: fileURLToPath(new URL("..", import.meta.url)),
  env: { PATH: process.env.PATH ?? "" },
};

test("the built server offers 160 tools over stdio", async () => {
  const transport = new StdioClientTransport({ ...server, stderr: "pipe" });
  const client = new Client({ name: "e2e", version: "0.0.0" });
  await client.connect(transport);

  try {
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(160);
  } finally {
    await client.close();
  }
});

/** The client skips lines that are not JSON, so stdout is read raw here. */
test("the built server writes nothing but JSON-RPC messages to stdout", async () => {
  const child = spawn(server.command, server.args, {
    cwd: server.cwd,
    env: server.env,
  });
  let stdout = "";
  const listed = new Promise<void>((resolve) => {
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.includes('"id":2') && stdout.endsWith("\n")) resolve();
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
      clientInfo: { name: "e2e", version: "0.0.0" },
    },
  });
  send({ method: "notifications/initialized" });
  send({ id: 2, method: "tools/list" });

  await listed;
  child.kill();

  const lines = stdout.split("\n").filter((line) => line !== "");
  expect(lines.length).toBeGreaterThanOrEqual(2);
  expect(lines.filter((line) => !isJsonRpc(line))).toEqual([]);
});

function isJsonRpc(line: string): boolean {
  try {
    return (JSON.parse(line) as { jsonrpc?: unknown }).jsonrpc === "2.0";
  } catch {
    return false;
  }
}
