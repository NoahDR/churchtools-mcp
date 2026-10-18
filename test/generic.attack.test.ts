import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { type Server, createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterAll, afterEach, expect, test } from "vitest";
import { createCtClient } from "../src/ct/client.js";
import { loginRequired } from "../src/ct/session.js";
import { type Dependencies, createServer } from "../src/server.js";
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

const spec = readFileSync(
  new URL("./fixtures/openapi.min.json", import.meta.url),
  "utf8",
);
const specPath = "/churchtools/system/runtime/swagger/openapi.json";
const api = "/churchtools/api";

const tempRoot = mkdtempSync(join(tmpdir(), "churchtools-mcp-attack-"));
afterAll(() => {
  chmodSync(tempRoot, 0o700);
  rmSync(tempRoot, { recursive: true, force: true });
});
let dirCount = 0;
const newCacheDir = () => join(tempRoot, `cache-${++dirCount}`);

const info = (version = "3.137.1") =>
  json({ version, build: "1", siteName: "Demo" });
const specAnswer = (text = spec) =>
  new Response(text, { headers: { "content-type": "application/json" } });
const specLoad = (text = spec) => [info(), specAnswer(text)];
const fixturePaths = (JSON.parse(spec) as { paths: Record<string, unknown> })
  .paths;

/** A spec of the given paths, each path item as given. */
const specOf = (paths: Record<string, unknown>) =>
  JSON.stringify({ openapi: "3.1.0", info: { title: "T" }, paths });

async function connectClient(deps: Dependencies): Promise<Client> {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await createServer(deps).connect(serverTransport);
  const client = new Client({ name: "attack-client", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

async function call(client: Client, name: string, args: unknown = {}) {
  const result = await client.callTool({
    name,
    arguments: args as Record<string, unknown>,
  });
  const [content] = result.content as { type: string; text: string }[];
  const text = content?.text ?? "";
  return { isError: result.isError ?? false, text };
}

async function ok(client: Client, name: string, args: unknown) {
  const { isError, text } = await call(client, name, args);
  expect(isError, text).toBe(false);
  return JSON.parse(text) as Record<string, unknown>;
}

/** A logged-in server whose later requests get `answers`; `requests` lists only those. */
async function ready(
  answers: (Response | Error)[],
  { cacheDir }: { cacheDir?: string } = {},
) {
  const { fetch, calls } = fakeFetch(...loginAnswers(), ...answers);
  const client = await connectClient({ env, fetch, cacheDir });
  await call(client, "ct_login", { code });
  calls.splice(0);
  const requests = () => calls.map((c) => `${c.method} ${c.path}`);
  return { client, calls, requests };
}

// Path values

test.each([
  ["a semicolon", "/persons/1;drop"],
  ["an umlaut", "/persons/M%C3%BCller"],
  ["a raw umlaut", "/persons/Müller"],
  ["decomposed unicode", "/persons/Müller"],
  ["full-width digits", "/persons/１２"],
  ["a zero-width space", "/persons/1​2"],
  ["a trailing newline", "/persons/12\n"],
  ["a tab", "/persons/1\t2"],
  ["a NUL byte", "/persons/12\u0000"],
  ["an encoded space", "/persons/1%202"],
  ["an encoded question mark", "/persons/1%3Fx"],
  ["an encoded hash", "/persons/1%23x"],
  ["a question mark inside a deeper value", "/groups/3?/members/12"],
  ["a hash inside a deeper value", "/groups/3#/members/12"],
  ["an at sign", "/persons/a@b"],
  ["a colon", "/persons/1:2"],
  ["three dots", "/persons/..."],
  ["a plus", "/persons/1+2"],
])(
  "ct_api_request rejects a path value with %s and sends nothing",
  async (_, path) => {
    const { client, requests } = await ready(specLoad());

    const { isError } = await call(client, "ct_api_request", {
      method: "GET",
      path,
    });

    expect(isError).toBe(true);
    expect(requests().slice(2)).toEqual([]);
  },
);

test.each([
  ["a negative number", "/persons/-1", `${api}/persons/-1`],
  ["the allowed symbols", "/persons/a_b.c~d-e", `${api}/persons/a_b.c~d-e`],
  ["a string for an integer parameter", "/persons/abc", `${api}/persons/abc`],
])("ct_api_request sends a value with %s unchanged", async (_, path, sent) => {
  const { client, requests } = await ready([...specLoad(), json({ data: {} })]);

  await ok(client, "ct_api_request", { method: "GET", path });

  expect(requests()[2]).toBe(`GET ${sent}`);
});

test("a concrete path that fits a string and an integer template GETs the one with GET", async () => {
  const { client, requests } = await ready([...specLoad(), json({ data: [] })]);

  await ok(client, "ct_api_request", { method: "GET", path: "/files/avatar" });
  const operation = await ok(client, "ct_get_operation", {
    method: "PATCH",
    path: "/files/avatar",
  });

  expect(requests()[2]).toBe(`GET ${api}/files/avatar`);
  expect(operation).toMatchObject({ path: "/files/{id}" });
});

test("a PATCH on a template without a GET is not guarded by the GET of a sibling template", async () => {
  const { client, requests } = await ready(specLoad());

  const plan = await ok(client, "ct_api_request", {
    method: "PATCH",
    path: "/files/12",
    body: { name: "x" },
  });

  expect(plan.token).toEqual(expect.any(String));
  expect(requests()).toEqual([`GET ${api}/info`, `GET ${specPath}`]);
});

// Methods

test.each(["get", "Get", "HEAD", "OPTIONS", "TRACE", "CONNECT", ""])(
  "ct_api_request rejects the method %j without a request",
  async (method) => {
    const { client, requests } = await ready(specLoad());

    const { isError } = await call(client, "ct_api_request", {
      method,
      path: "/persons/12",
    });

    expect(isError).toBe(true);
    expect(requests()).toEqual([]);
  },
);

test.each(["patch", "HEAD"])(
  "ct_get_operation rejects the method %j",
  async (method) => {
    const { client, requests } = await ready(specLoad());

    const { isError } = await call(client, "ct_get_operation", {
      method,
      path: "/persons/{personId}",
    });

    expect(isError).toBe(true);
    expect(requests()).toEqual([]);
  },
);

// Query values

test.each([
  ["null", { limit: null }],
  ["an object", { filter: { a: 1 } }],
  ["a nested array", { "ids[]": [[1, 2]] }],
  ["an array with null", { "ids[]": [1, null] }],
  ["an array with a boolean", { "ids[]": [true] }],
  ["an array with an object", { "ids[]": [{ id: 1 }] }],
])("ct_api_request rejects a query value that is %s", async (_, query) => {
  const { client, requests } = await ready(specLoad());

  const { isError } = await call(client, "ct_api_request", {
    method: "GET",
    path: "/persons",
    query,
  });

  expect(isError).toBe(true);
  expect(requests()).toEqual([]);
});

test("query keys and values with URL syntax are encoded, not interpreted", async () => {
  const { client, requests } = await ready([...specLoad(), json({ data: [] })]);

  await ok(client, "ct_api_request", {
    method: "GET",
    path: "/persons",
    query: { "a&b": "c=d#e?f", "ids[]": [], empty: "", flag: false },
  });

  expect(requests()[2]).toBe(
    `GET ${api}/persons?a%26b=c%3Dd%23e%3Ff&empty=&flag=false`,
  );
});

// Bodies

test.each([
  ["null", null],
  ["false", false],
  ["0", 0],
  ["an empty string", ""],
])("a GET with the body %s is rejected without a request", async (_, body) => {
  const { client, requests } = await ready(specLoad());

  const { isError } = await call(client, "ct_api_request", {
    method: "GET",
    path: "/persons/12",
    body,
  });

  expect(isError).toBe(true);
  expect(requests()).toEqual([]);
});

test("a POST with a 2 MB body becomes a plan and sends the body unchanged", async () => {
  const { client, calls, requests } = await ready([
    ...specLoad(),
    json({ data: { id: 1 } }),
  ]);
  const body = { name: "x".repeat(2 * 1024 * 1024) };

  const plan = await ok(client, "ct_api_request", {
    method: "POST",
    path: "/calendars",
    body,
  });
  calls.splice(0);
  await ok(client, "ct_execute_plan", { token: plan.token });

  expect(requests()).toEqual([`POST ${api}/calendars`]);
  expect(calls[0]?.body).toEqual(body);
});

// Search

test.each([".*", "(", "[persons", "\\", "^/persons$", "a|b", "$&", "?"])(
  "ct_search_api treats %j as plain text",
  async (query) => {
    const { client } = await ready(specLoad());

    const result = await ok(client, "ct_search_api", { query });

    expect(result.total).toBe(0);
  },
);

test("ct_search_api finds a template by its {param} text", async () => {
  const { client } = await ready(specLoad());

  const result = await ok(client, "ct_search_api", { query: "{personId}" });

  expect(result.total).toBe(7);
});

// ct_get_operation on large operations

test("ct_get_operation cuts an operation with a very wide schema", async () => {
  const properties = Object.fromEntries(
    Array.from({ length: 50_000 }, (_, i) => [`field${i}`, { type: "string" }]),
  );
  const wide = specOf({
    "/wide": {
      post: {
        summary: "Wide",
        requestBody: {
          content: {
            "application/json": { schema: { type: "object", properties } },
          },
        },
      },
    },
  });
  const { client } = await ready(specLoad(wide));

  const result = await ok(client, "ct_get_operation", {
    method: "POST",
    path: "/wide",
  });

  expect(result.truncated).toBe(true);
  expect((result.text as string).length).toBeLessThanOrEqual(20_000);
});

test("ct_get_operation prunes a schema nested 20 000 levels deep", async () => {
  const deep =
    '{"type":"object","properties":{"x":'.repeat(20_000) +
    "{}" +
    "}}".repeat(20_000);
  const nested = `{"openapi":"3.1.0","paths":{"/deep":{"post":{"summary":"Deep","requestBody":{"content":{"application/json":{"schema":${deep}}}}}}}}`;
  const { client } = await ready(specLoad(nested));

  const result = await call(client, "ct_get_operation", {
    method: "POST",
    path: "/deep",
  });

  expect(result.isError, result.text).toBe(false);
  expect(result.text).toContain('"…"');
  expect(result.text.length).toBeLessThan(1_000);
});

// Loading the spec

test("concurrent first calls of all three tools share one load of the spec", async () => {
  const { client, requests } = await ready([
    ...specLoad(),
    json({ data: { id: 12 } }),
  ]);

  await Promise.all([
    ok(client, "ct_search_api", { query: "person" }),
    ok(client, "ct_get_operation", {
      method: "GET",
      path: "/persons/{personId}",
    }),
    ok(client, "ct_api_request", { method: "GET", path: "/persons/12" }),
  ]);

  expect(requests()).toEqual([
    `GET ${api}/info`,
    `GET ${specPath}`,
    `GET ${api}/persons/12`,
  ]);
});

test("concurrent first calls share one failed load, and the next call loads again", async () => {
  const { client, requests } = await ready([
    info(),
    new Response("", { status: 503 }),
    ...specLoad(),
  ]);

  const failed = await Promise.all([
    call(client, "ct_search_api", { query: "person" }),
    call(client, "ct_search_api", { query: "group" }),
  ]);
  const retried = await call(client, "ct_search_api", { query: "person" });

  expect(failed.map((f) => f.isError)).toEqual([true, true]);
  expect(retried.isError).toBe(false);
  expect(requests()).toHaveLength(4);
});

test("a 401 on /info during the spec load logs out, and after a new login the spec loads", async () => {
  const { fetch, calls } = fakeFetch(
    ...loginAnswers(),
    json({ message: "Session expired!" }, { status: 401 }),
    ...loginAnswers(),
    ...specLoad(),
  );
  const client = await connectClient({ env, fetch });
  await call(client, "ct_login", { code });

  const expired = await call(client, "ct_search_api", { query: "person" });
  const status = await call(client, "ct_status");
  await call(client, "ct_login", { code });
  calls.splice(0);
  const result = await ok(client, "ct_search_api", { query: "person" });

  expect(expired.text).toContain(loginRequired);
  expect(status.text).toContain("logged_out");
  expect(result.total).toBeGreaterThan(0);
  expect(calls.map((c) => c.path)).toEqual([`${api}/info`, specPath]);
});

test("an /info answer without a version is a clear error", async () => {
  const { client } = await ready([json({ build: "1" })]);

  const { isError, text } = await call(client, "ct_search_api", {
    query: "person",
  });

  expect(isError).toBe(true);
  expect(text).toContain("/info");
});

test("a network error on the spec is a clear error", async () => {
  const { client } = await ready([info(), new TypeError("fetch failed")]);

  const { isError, text } = await call(client, "ct_search_api", {
    query: "person",
  });

  expect(isError).toBe(true);
  expect(text).toContain("Could not load the OpenAPI spec");
});

test("a re-login keeps the loaded spec for the process", async () => {
  const { fetch, calls } = fakeFetch(
    ...loginAnswers(),
    ...specLoad(),
    ...loginAnswers(),
  );
  const client = await connectClient({ env, fetch });
  await call(client, "ct_login", { code });
  await ok(client, "ct_search_api", { query: "person" });
  await call(client, "ct_login", { code });
  calls.splice(0);

  await ok(client, "ct_search_api", { query: "group" });

  expect(calls).toEqual([]);
});

test("an OpenAPI x- extension under paths does not void the other paths", async () => {
  const extended = specOf({ ...fixturePaths, "x-generated": true });
  const { client } = await ready(specLoad(extended));

  const result = await call(client, "ct_search_api", { query: "persons" });

  expect(result.isError, result.text).toBe(false);
});

// Cache directory

test("a read-only cache directory still serves a cached spec", async () => {
  const cacheDir = newCacheDir();
  const first = await ready(specLoad(), { cacheDir });
  await ok(first.client, "ct_search_api", { query: "person" });
  chmodSync(cacheDir, 0o500);

  const second = await ready([info()], { cacheDir });
  const result = await ok(second.client, "ct_search_api", { query: "person" });

  chmodSync(cacheDir, 0o700);
  expect(second.requests()).toEqual([`GET ${api}/info`]);
  expect(result.total).toBeGreaterThan(0);
});

test("an unreadable and unwritable cache directory does not fail the tool", async () => {
  const cacheDir = newCacheDir();
  mkdirSync(cacheDir);
  chmodSync(cacheDir, 0o000);
  const { client } = await ready(specLoad(), { cacheDir });

  const result = await ok(client, "ct_search_api", { query: "person" });

  chmodSync(cacheDir, 0o700);
  expect(result.total).toBeGreaterThan(0);
  expect(readdirSync(cacheDir)).toEqual([]);
});

test("a directory in place of the cache file is a miss and does not fail the tool", async () => {
  const cacheDir = newCacheDir();
  mkdirSync(join(cacheDir, "example.org%2Fchurchtools-3.137.1.json"), {
    recursive: true,
  });
  const { client } = await ready(specLoad(), { cacheDir });

  const result = await ok(client, "ct_search_api", { query: "person" });

  expect(result.total).toBeGreaterThan(0);
  expect(readdirSync(cacheDir)).toHaveLength(1);
});

test("a version too long for a file name does not fail the tool", async () => {
  const cacheDir = newCacheDir();
  const { client } = await ready([info("9".repeat(400)), specAnswer()], {
    cacheDir,
  });

  const result = await ok(client, "ct_search_api", { query: "person" });

  expect(result.total).toBeGreaterThan(0);
});

test("two servers loading into one cache directory at once leave one valid file", async () => {
  const cacheDir = newCacheDir();
  const a = await ready(specLoad(), { cacheDir });
  const b = await ready(specLoad(), { cacheDir });

  await Promise.all([
    ok(a.client, "ct_search_api", { query: "person" }),
    ok(b.client, "ct_search_api", { query: "person" }),
  ]);

  const files = readdirSync(cacheDir);
  expect(files).toEqual(["example.org%2Fchurchtools-3.137.1.json"]);
  const text = readFileSync(join(cacheDir, files[0] ?? ""), "utf8");
  expect(() => {
    JSON.parse(text);
  }).not.toThrow();
});

// Secrets through the generic GET

test("ct_api_request does not hand out the session's CSRF token", async () => {
  const withCsrf = specOf({
    ...fixturePaths,
    "/csrftoken": { get: { summary: "Get CSRF token", tags: ["General"] } },
  });
  const { client } = await ready([
    ...specLoad(withCsrf),
    json({ data: csrfToken }),
  ]);

  const { text } = await call(client, "ct_api_request", {
    method: "GET",
    path: "/csrftoken",
  });

  for (const secret of secrets) expect(text).not.toContain(secret);
});

test.each([
  ["a trailing slash", "/csrftoken/", "GET"],
  ["another case", "/CsrfToken", "GET"],
  ["a trailing slash after a parameter", "/persons/12/logintoken/", "GET"],
  ["a trailing slash on logout", "/logout/", "POST"],
])(
  "a secret path spelled with %s in the spec is not exposed either",
  async (_, path, method) => {
    const template = path.replace("/12/", "/{personId}/");
    const variant = specOf({
      ...fixturePaths,
      [template]: { [method.toLowerCase()]: { summary: "Secret" } },
    });
    const { client, requests } = await ready([
      ...specLoad(variant),
      json({ data: csrfToken }),
    ]);

    const { isError, text } = await call(client, "ct_api_request", {
      method,
      path,
    });

    expect(isError, text).toBe(true);
    expect(text).toContain("not exposed");
    expect(requests()).toHaveLength(2);
  },
);

test("ct_status does not show the raw error body of /info", async () => {
  const { client } = await ready([
    new Response(`<html>session ${cookieValue}</html>`, { status: 500 }),
  ]);

  const { text } = await call(client, "ct_status");

  expect(text).toContain("500");
  for (const secret of secrets) expect(text).not.toContain(secret);
});

// getFile against a real HTTP server

let httpServer: Server | undefined;
afterEach(async () => {
  const server = httpServer;
  httpServer = undefined;
  if (!server) return;
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

/** A local HTTP server on 127.0.0.1 and a client on it with the real fetch. */
async function serve(
  handler: Parameters<typeof createHttpServer>[1],
): Promise<ReturnType<typeof createCtClient>> {
  const server = createHttpServer(handler);
  httpServer = server;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error();
  return createCtClient({
    baseUrl: `http://127.0.0.1:${address.port}`,
    fetch: globalThis.fetch,
  });
}

test("getFile decodes a gzip body", async () => {
  const body = gzipSync(JSON.stringify({ paths: { "/ü": {} } }));
  const client = await serve((_, res) => {
    res.writeHead(200, {
      "content-type": "application/json",
      "content-encoding": "gzip",
      "content-length": body.length,
    });
    res.end(body);
  });

  expect(await client.getFile("/spec.json", 1024)).toEqual({
    paths: { "/ü": {} },
  });
});

test("getFile refuses a gzip body that unpacks above the limit though its declared length is small", async () => {
  const body = gzipSync(Buffer.alloc(8 * 1024 * 1024, 32));
  const client = await serve((_, res) => {
    res.writeHead(200, {
      "content-encoding": "gzip",
      "content-length": body.length,
    });
    res.end(body);
  });

  expect(body.length).toBeLessThan(1024 * 1024);
  await expect(client.getFile("/spec.json", 1024 * 1024)).rejects.toThrow(
    "larger than",
  );
});

test("getFile stops reading a chunked body above the limit", async () => {
  const chunk = Buffer.alloc(64 * 1024, 32);
  const total = 256 * 1024 * 1024;
  let written = 0;
  let closedEarly = false;
  const client = await serve((_, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.on("close", () => {
      closedEarly = written < total;
    });
    const pump = () => {
      while (written < total && !res.destroyed) {
        written += chunk.length;
        if (!res.write(chunk)) return void res.once("drain", pump);
      }
      res.end();
    };
    pump();
  });

  await expect(client.getFile("/spec.json", 1024 * 1024)).rejects.toThrow(
    "larger than",
  );
  await new Promise((resolve) => setTimeout(resolve, 100));

  expect(closedEarly).toBe(true);
  expect(written).toBeLessThan(64 * 1024 * 1024);
});

// getFile limits with fake bodies

const baseUrl = "https://example.org/churchtools";

function chunked(...chunks: Uint8Array[]): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(c);
        controller.close();
      },
    }),
  );
}

test("getFile accepts a body of exactly the limit and refuses one byte more", async () => {
  const exact = createCtClient({
    baseUrl,
    fetch: fakeFetch(chunked(new TextEncoder().encode('"1234"'))).fetch,
  });
  const over = createCtClient({
    baseUrl,
    fetch: fakeFetch(chunked(new TextEncoder().encode('"12345"'))).fetch,
  });

  expect(await exact.getFile("/f", 6)).toBe("1234");
  await expect(over.getFile("/f", 6)).rejects.toThrow("larger than");
});

test("getFile refuses a body longer than its declared content-length allows", async () => {
  const lying = chunked(new Uint8Array(2048).fill(32));
  const response = new Response(lying.body, {
    headers: { "content-length": "10" },
  });
  const client = createCtClient({ baseUrl, fetch: fakeFetch(response).fetch });

  await expect(client.getFile("/f", 100)).rejects.toThrow("larger than");
});

test("getFile decodes a UTF-8 character split across two chunks", async () => {
  const bytes = new TextEncoder().encode('"Müller"');
  const split = bytes.indexOf(0xc3) + 1;
  const client = createCtClient({
    baseUrl,
    fetch: fakeFetch(chunked(bytes.slice(0, split), bytes.slice(split))).fetch,
  });

  expect(await client.getFile("/f", 100)).toBe("Müller");
});

test("getFile cancels the body once it passes the limit", async () => {
  let pulls = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls++;
      controller.enqueue(new Uint8Array(1024));
    },
    cancel() {
      cancelled = true;
    },
  });
  const client = createCtClient({
    baseUrl,
    fetch: fakeFetch(new Response(body)).fetch,
  });

  await expect(client.getFile("/f", 4096)).rejects.toThrow("larger than");

  expect(cancelled).toBe(true);
  expect(pulls).toBeLessThan(10);
});
