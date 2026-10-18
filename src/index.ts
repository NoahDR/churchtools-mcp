import { homedir } from "node:os";
import { join } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { createServer } from "./server.js";

const cacheDir = join(homedir(), ".cache", "churchtools-mcp");

await createServer({ env: process.env, fetch, cacheDir }).connect(
  new StdioServerTransport(),
);
