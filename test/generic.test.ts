import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterAll, expect, test } from "vitest";
import { loginRequired } from "../src/ct/session.js";
import { type Dependencies, createServer } from "../src/server.js";
import {
  code,
  cookieValue,
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
const person = { id: 12, firstName: "Ben", email: "ben@example.org" };

const tempRoot = mkdtempSync(join(tmpdir(), "churchtools-mcp-test-"));
afterAll(() => rmSync(tempRoot, { recursive: true, force: true }));
let dirCount = 0;
const newCacheDir = () => join(tempRoot, `cache-${++dirCount}`);

const info = (version = "3.137.1") =>
  json({ version, build: "1", siteName: "Demo" });
const specAnswer = (text = spec) =>
  new Response(text, { headers: { "content-type": "application/json" } });
/** The answers of the first generic call: /info, then the spec. */
const specLoad = (text = spec) => [info(), specAnswer(text)];

async function connectClient(deps: Dependencies): Promise<Client> {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await createServer(deps).connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

/** A logged-in server whose later requests get `answers`; `calls` holds only those later requests. */
async function ready(
  answers: (Response | Error)[],
  { cacheDir, ctUrl }: { cacheDir?: string; ctUrl?: string } = {},
) {
  const { fetch, calls } = fakeFetch(...loginAnswers(), ...answers);
  const client = await connectClient({
    env: { ...env, ...(ctUrl && { CT_URL: ctUrl }) },
    fetch,
    cacheDir,
  });
  await call(client, "ct_login", { code });
  calls.splice(0);
  const requests = () => calls.map((c) => `${c.method} ${c.path}`);
  return { client, calls, requests };
}

async function call(client: Client, name: string, args: unknown = {}) {
  const result = await client.callTool({
    name,
    arguments: args as Record<string, unknown>,
  });
  const [content] = result.content as { type: string; text: string }[];
  const text = content?.text ?? "";
  for (const secret of secrets) expect(text).not.toContain(secret);
  return { isError: result.isError ?? false, text };
}

async function ok(client: Client, name: string, args: unknown) {
  const { isError, text } = await call(client, name, args);
  expect(isError, text).toBe(false);
  return JSON.parse(text) as Record<string, unknown>;
}

function depth(value: unknown): number {
  if (typeof value !== "object" || value === null) return 0;
  return 1 + Math.max(0, ...Object.values(value).map(depth));
}

// Loading and caching the spec

test("the spec is fetched once, from outside /api, with the session cookie", async () => {
  const { client, calls, requests } = await ready(specLoad());

  await ok(client, "ct_search_api", { query: "person" });
  await ok(client, "ct_search_api", { query: "group" });

  expect(requests()).toEqual([`GET ${api}/info`, `GET ${specPath}`]);
  expect(calls[1]?.headers.get("cookie")).toContain(cookieValue);
});

test("without a login the generic tools ask for the 2FA code and send nothing", async () => {
  const { fetch, calls } = fakeFetch();
  const client = await connectClient({ env, fetch });

  const { isError, text } = await call(client, "ct_search_api", {
    query: "person",
  });

  expect(isError).toBe(true);
  expect(text).toContain(loginRequired);
  expect(calls).toHaveLength(0);
});

test("a 401 on the spec logs out and asks for the 2FA code", async () => {
  const { client } = await ready([
    info(),
    json({ message: "Session expired!" }, { status: 401 }),
  ]);

  const { isError, text } = await call(client, "ct_search_api", {
    query: "person",
  });
  const status = await call(client, "ct_status");

  expect(isError).toBe(true);
  expect(text).toContain(loginRequired);
  expect(status.text).toContain("logged_out");
});

test("a 404 on the spec is a clear error, and the next call loads again", async () => {
  const { client, requests } = await ready([
    info(),
    new Response(`<html>${cookieValue} not here</html>`, { status: 404 }),
    ...specLoad(),
  ]);

  const failed = await call(client, "ct_search_api", { query: "person" });
  const retried = await call(client, "ct_search_api", { query: "person" });

  expect(failed.isError).toBe(true);
  expect(failed.text).toContain("OpenAPI spec");
  expect(failed.text).toContain("404");
  expect(retried.isError).toBe(false);
  expect(requests()).toHaveLength(4);
});

test("a spec that is not JSON is a clear error that does not echo the body", async () => {
  const { client } = await ready([
    info(),
    specAnswer(`<html>cookie ${cookieValue}</html>`),
  ]);

  const { isError, text } = await call(client, "ct_search_api", {
    query: "person",
  });

  expect(isError).toBe(true);
  expect(text).toContain("not valid JSON");
});

test("a JSON spec without paths is a clear error", async () => {
  const { client } = await ready([info(), specAnswer('{"openapi":"3.1.0"}')]);

  const { isError, text } = await call(client, "ct_search_api", {
    query: "person",
  });

  expect(isError).toBe(true);
  expect(text).toContain("OpenAPI spec");
});

function endlessBody(): Response {
  const chunk = new Uint8Array(1024 * 1024).fill(32);
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent++ >= 300) controller.close();
      else controller.enqueue(chunk);
    },
  });
  return new Response(body);
}

test("a spec body above the size limit is a clear error", async () => {
  const { client } = await ready([info(), endlessBody()]);

  const { isError, text } = await call(client, "ct_search_api", {
    query: "person",
  });

  expect(isError).toBe(true);
  expect(text).toContain("larger than");
});

test("a declared content-length above the size limit is refused before reading", async () => {
  const huge = new Response("{}", {
    headers: { "content-length": String(1024 * 1024 * 1024) },
  });
  const { client } = await ready([info(), huge]);

  const { isError, text } = await call(client, "ct_search_api", {
    query: "person",
  });

  expect(isError).toBe(true);
  expect(text).toContain("larger than");
});

test("a second server with the same cache directory reads the spec from disk", async () => {
  const cacheDir = newCacheDir();
  const first = await ready(specLoad(), { cacheDir });
  await ok(first.client, "ct_search_api", { query: "person" });

  const second = await ready([info()], { cacheDir });
  const result = await ok(second.client, "ct_search_api", { query: "person" });

  expect(second.requests()).toEqual([`GET ${api}/info`]);
  expect(result.total).toBeGreaterThan(0);
});

test("the cache file name holds host, path and version", async () => {
  const cacheDir = newCacheDir();
  const { client } = await ready(specLoad(), { cacheDir });

  await ok(client, "ct_search_api", { query: "person" });

  expect(readdirSync(cacheDir)).toEqual([
    "example.org%2Fchurchtools-3.137.1.json",
  ]);
});

test("two servers without a cache directory do not share the spec", async () => {
  const first = await ready(specLoad());
  await ok(first.client, "ct_search_api", { query: "person" });
  const second = await ready(specLoad());

  await ok(second.client, "ct_search_api", { query: "person" });

  expect(second.requests()).toEqual([`GET ${api}/info`, `GET ${specPath}`]);
});

test.each([
  ["another host", "https://other.example.org/churchtools", "3.137.1"],
  ["another path on the same host", "https://example.org/other", "3.137.1"],
  ["another version", undefined, "3.138.0"],
])("%s does not use the cached spec", async (_, ctUrl, version) => {
  const cacheDir = newCacheDir();
  const first = await ready(specLoad(), { cacheDir });
  await ok(first.client, "ct_search_api", { query: "person" });

  const second = await ready([info(version), specAnswer()], {
    cacheDir,
    ctUrl,
  });
  await ok(second.client, "ct_search_api", { query: "person" });

  expect(second.requests()).toHaveLength(2);
  expect(readdirSync(cacheDir)).toHaveLength(2);
});

test.each([
  ["corrupt", () => "not json at all"],
  ["partial", (text: string) => text.slice(0, text.length / 2)],
  ["of the wrong shape", () => '{"paths": 42}'],
])("a %s cache file is ignored, refetched and replaced", async (_, damage) => {
  const cacheDir = newCacheDir();
  const first = await ready(specLoad(), { cacheDir });
  await ok(first.client, "ct_search_api", { query: "person" });
  const [file = ""] = readdirSync(cacheDir);
  const good = readFileSync(join(cacheDir, file), "utf8");
  writeFileSync(join(cacheDir, file), damage(good));

  const second = await ready(specLoad(), { cacheDir });
  const result = await ok(second.client, "ct_search_api", {
    query: "person",
  });

  expect(second.requests()).toEqual([`GET ${api}/info`, `GET ${specPath}`]);
  expect(result.total).toBeGreaterThan(0);
  expect(readFileSync(join(cacheDir, file), "utf8")).toBe(good);
});

test("a version with path characters stays inside the cache directory", async () => {
  const cacheDir = newCacheDir();
  const { client } = await ready([info("../../../escaped"), specAnswer()], {
    cacheDir,
  });

  await ok(client, "ct_search_api", { query: "person" });

  expect(readdirSync(cacheDir)).toHaveLength(1);
  expect(readdirSync(tempRoot)).not.toContain("escaped.json");
});

test("an unwritable cache directory does not fail the tool", async () => {
  const cacheDir = newCacheDir();
  writeFileSync(cacheDir, "a file, not a directory");
  const { client } = await ready(specLoad(), { cacheDir });

  const result = await ok(client, "ct_search_api", { query: "person" });

  expect(result.total).toBeGreaterThan(0);
});

// ct_search_api

test("ct_search_api finds operations by path, summary and tag", async () => {
  const { client } = await ready(specLoad());

  const byPath = await ok(client, "ct_search_api", { query: "eventservices" });
  const bySummary = await ok(client, "ct_search_api", {
    query: "rule set automatic",
  });
  const byTag = await ok(client, "ct_search_api", { query: "general" });

  expect(byPath.operations).toContainEqual({
    method: "DELETE",
    path: "/events/{eventId}/eventservices/{serviceId}",
    summary: "Delete event service",
    tags: ["Event"],
  });
  expect((bySummary.operations as unknown[])[0]).toMatchObject({
    method: "PUT",
    path: "/dynamicgroups/{groupId}/ruleset",
  });
  expect(byTag.operations).toMatchObject([{ method: "GET", path: "/info" }]);
});

test("ct_search_api ignores case", async () => {
  const { client } = await ready(specLoad());

  const lower = await ok(client, "ct_search_api", { query: "persons" });
  const upper = await ok(client, "ct_search_api", { query: "PERSONS" });

  expect(upper).toEqual(lower);
  expect(lower.total).toBe(5);
});

test("ct_search_api ranks operations that match more keywords first", async () => {
  const { client } = await ready(specLoad());

  const { operations } = await ok(client, "ct_search_api", {
    query: "delete persons",
  });

  expect((operations as unknown[])[0]).toMatchObject({
    method: "DELETE",
    path: "/persons/{personId}",
  });
});

test("ct_search_api without a match returns an empty list", async () => {
  const { client } = await ready(specLoad());

  const result = await ok(client, "ct_search_api", { query: "xyzzy" });

  expect(result).toEqual({ total: 0, operations: [] });
});

test("ct_search_api returns at most `limit` operations and the total", async () => {
  const { client } = await ready(specLoad());

  const result = await ok(client, "ct_search_api", {
    query: "persons",
    limit: 2,
  });

  expect(result.operations).toHaveLength(2);
  expect(result.total).toBe(5);
});

test.each([
  ["an empty query", { query: "" }],
  ["a blank query", { query: "   " }],
  ["limit 0", { query: "person", limit: 0 }],
  ["limit 101", { query: "person", limit: 101 }],
  ["a fractional limit", { query: "person", limit: 1.5 }],
])("ct_search_api rejects %s without a request", async (_, args) => {
  const { client, calls } = await ready([]);

  const { isError } = await call(client, "ct_search_api", args);

  expect(isError).toBe(true);
  expect(calls).toHaveLength(0);
});

// ct_get_operation

test("ct_get_operation returns path-level and own parameters and the request body", async () => {
  const { client } = await ready(specLoad());

  const operation = await ok(client, "ct_get_operation", {
    method: "PATCH",
    path: "/persons/{personId}",
  });

  expect(operation).toMatchObject({
    method: "PATCH",
    path: "/persons/{personId}",
    summary: "Updates a person",
    parameters: [{ name: "personId", in: "path", required: true }],
    requestBody: { content: { "application/json": { schema: {} } } },
  });
  expect(operation).not.toHaveProperty("responses");
});

test("ct_get_operation also takes a concrete path", async () => {
  const { client } = await ready(specLoad());

  const operation = await ok(client, "ct_get_operation", {
    method: "GET",
    path: "/persons/12",
  });

  expect(operation).toMatchObject({ path: "/persons/{personId}" });
});

test.each([
  ["an unknown path", "GET", "/nothing"],
  ["a method the path does not have", "PUT", "/persons/{personId}"],
])("ct_get_operation rejects %s", async (_, method, path) => {
  const { client } = await ready(specLoad());

  const { isError, text } = await call(client, "ct_get_operation", {
    method,
    path,
  });

  expect(isError).toBe(true);
  expect(text).toContain("ct_search_api");
});

test("ct_get_operation prunes schemas below depth 4", async () => {
  const { client } = await ready(specLoad());

  const operation = await ok(client, "ct_get_operation", {
    method: "PUT",
    path: "/dynamicgroups/{groupId}/ruleset",
  });
  const body = operation.requestBody as {
    content: Record<string, { schema: unknown }>;
  };
  const schema = body.content["application/json"]?.schema;

  expect(JSON.stringify(schema)).toContain('"…"');
  expect(depth(schema)).toBe(5);
});

test.each([
  ["an even", ""],
  ["an odd", "a"],
])(
  "ct_get_operation cuts a long operation at 20 000 characters as valid text (%s offset)",
  async (_, prefix) => {
    const long = JSON.stringify({
      openapi: "3.1.0",
      info: { title: "Long", version: "0.1.0" },
      paths: {
        "/long": {
          get: { summary: "Long", description: prefix + "😀".repeat(15000) },
        },
      },
    });
    const { client } = await ready(specLoad(long));

    const result = await ok(client, "ct_get_operation", {
      method: "GET",
      path: "/long",
    });

    expect(result.truncated).toBe(true);
    expect(typeof result.text).toBe("string");
    const text = result.text as string;
    expect(text.length).toBeLessThanOrEqual(20000);
    expect(text.length).toBeGreaterThan(19990);
    expect(text.isWellFormed()).toBe(true);
  },
);

// ct_api_request: GET

test("ct_api_request runs a GET at once and returns the answer", async () => {
  const { client, requests } = await ready([
    ...specLoad(),
    json({ data: person }),
  ]);

  const result = await ok(client, "ct_api_request", {
    method: "GET",
    path: "/persons/12",
  });

  expect(result).toEqual({ data: person });
  expect(requests()).toEqual([
    `GET ${api}/info`,
    `GET ${specPath}`,
    `GET ${api}/persons/12`,
  ]);
});

test("ct_api_request sends `query` as the query string", async () => {
  const { client, requests } = await ready([...specLoad(), json({ data: [] })]);

  await ok(client, "ct_api_request", {
    method: "GET",
    path: "/persons",
    query: { query: "Ben", "ids[]": [1, 2], limit: 5 },
  });

  expect(requests()[2]).toBe(
    `GET ${api}/persons?query=Ben&ids%5B%5D=1&ids%5B%5D=2&limit=5`,
  );
});

test("a server error of a GET reports its message, not the raw body", async () => {
  const { client } = await ready([
    ...specLoad(),
    new Response(`<html>${cookieValue}</html>`, { status: 500 }),
  ]);

  const { isError, text } = await call(client, "ct_api_request", {
    method: "GET",
    path: "/persons/12",
  });

  expect(isError).toBe(true);
  expect(text).toContain("500");
});

test("a 400 of a GET reports the server message and field errors", async () => {
  const { client } = await ready([
    ...specLoad(),
    json(
      {
        message: "Invalid",
        errors: [{ fieldId: "limit", message: "too big" }],
      },
      { status: 400 },
    ),
  ]);

  const { isError, text } = await call(client, "ct_api_request", {
    method: "GET",
    path: "/persons",
  });

  expect(isError).toBe(true);
  expect(JSON.parse(text)).toMatchObject({
    error: "Invalid",
    status: 400,
    errors: [{ fieldId: "limit", message: "too big" }],
  });
});

test("a GET with a body is rejected without a request", async () => {
  const { client, requests } = await ready(specLoad());

  const { isError } = await call(client, "ct_api_request", {
    method: "GET",
    path: "/persons/12",
    body: { x: 1 },
  });

  expect(isError).toBe(true);
  expect(requests()).toHaveLength(0);
});

test.each([
  ["a trailing slash", "/persons/12/"],
  ["a dot-dot segment", "/persons/.."],
  ["a dot segment", "/persons/."],
  ["an encoded dot-dot", "/persons/%2e%2e"],
  ["an encoded slash", "/persons/1%2F..%2Finfo"],
  ["a backslash", "/persons/1\\..\\info"],
  ["a query string", "/persons/12?x=1"],
  ["a fragment", "/persons/12#x"],
  ["an absolute URL", "https://evil.example/api/persons/12"],
  ["a protocol-relative URL", "//evil.example/persons/12"],
  ["no leading slash", "persons/12"],
  ["an empty segment", "/persons//12"],
  ["a template instead of a value", "/persons/{personId}"],
  ["a space in a value", "/persons/1 2"],
  ["an unknown path", "/nothing/12"],
  ["an extra segment", "/persons/12/extra"],
  ["a different case", "/Persons/12"],
])("ct_api_request rejects %s before any request", async (_, path) => {
  const { client, requests } = await ready(specLoad());

  const { isError, text } = await call(client, "ct_api_request", {
    method: "GET",
    path,
  });

  expect(isError).toBe(true);
  expect(text).toMatch(/ct_search_api|query|leading/);
  expect(requests().slice(2)).toEqual([]);
});

test("of two templates with the same shape, the one with the method is used", async () => {
  const { client, requests } = await ready(specLoad());

  const plan = await ok(client, "ct_api_request", {
    method: "DELETE",
    path: "/files/12",
  });
  const operation = await ok(client, "ct_get_operation", {
    method: "DELETE",
    path: "/files/12",
  });

  expect(plan.token).toEqual(expect.any(String));
  expect(operation).toMatchObject({ path: "/files/{id}" });
  expect(requests()).toHaveLength(2);
});

test("a method the template does not have is rejected with the methods it has", async () => {
  const { client, requests } = await ready(specLoad());

  const { isError, text } = await call(client, "ct_api_request", {
    method: "PUT",
    path: "/persons/12",
  });

  expect(isError).toBe(true);
  expect(text).toContain("DELETE, GET, PATCH");
  expect(requests()).toHaveLength(2);
});

// ct_api_request: writes

test("a PATCH returns a plan guarded by the GET of the same path and writes nothing", async () => {
  const { client, requests } = await ready([
    ...specLoad(),
    json({ data: person }),
  ]);

  const plan = await ok(client, "ct_api_request", {
    method: "PATCH",
    path: "/persons/12",
    body: { email: "ben@new.org" },
  });

  expect(plan.token).toEqual(expect.any(String));
  expect(plan.preview).toMatchObject({
    changes: [
      {
        method: "PATCH",
        path: "/persons/12",
        fields: { email: { before: "ben@example.org", after: "ben@new.org" } },
      },
    ],
  });
  expect(requests()).toEqual([
    `GET ${api}/info`,
    `GET ${specPath}`,
    `GET ${api}/persons/12`,
  ]);
});

test("executing the PATCH plan re-reads the guard, then writes", async () => {
  const { client, calls, requests } = await ready([
    ...specLoad(),
    json({ data: person }),
    json({ data: person }),
    json({ data: { ...person, email: "ben@new.org" } }),
  ]);
  const plan = await ok(client, "ct_api_request", {
    method: "PATCH",
    path: "/persons/12",
    query: { force: true },
    body: { email: "ben@new.org" },
  });
  calls.splice(0);

  await ok(client, "ct_execute_plan", { token: plan.token });

  expect(requests()).toEqual([
    `GET ${api}/persons/12`,
    `PATCH ${api}/persons/12?force=true`,
  ]);
  expect(calls[1]?.body).toEqual({ email: "ben@new.org" });
});

test("a changed record between preview and execution aborts with zero writes", async () => {
  const { client, calls, requests } = await ready([
    ...specLoad(),
    json({ data: person }),
    json({ data: { ...person, firstName: "Benjamin" } }),
  ]);
  const plan = await ok(client, "ct_api_request", {
    method: "PATCH",
    path: "/persons/12",
    body: { email: "ben@new.org" },
  });
  calls.splice(0);

  const { isError, text } = await call(client, "ct_execute_plan", {
    token: plan.token,
  });

  expect(isError).toBe(true);
  expect(text).toContain("firstName");
  expect(requests()).toEqual([`GET ${api}/persons/12`]);
});

test("a PUT on a path whose GET answers 404 is guarded as absent", async () => {
  const { client, calls, requests } = await ready([
    ...specLoad(),
    json({ message: "Not found" }, { status: 404 }),
    json({ message: "Not found" }, { status: 404 }),
    json({ data: { personId: 12 } }),
  ]);
  const plan = await ok(client, "ct_api_request", {
    method: "PUT",
    path: "/groups/3/members/12",
    body: { groupTypeRoleId: 8 },
  });
  calls.splice(0);

  await ok(client, "ct_execute_plan", { token: plan.token });

  expect(requests()).toEqual([
    `GET ${api}/groups/3/members/12`,
    `PUT ${api}/groups/3/members/12`,
  ]);
});

test("a GET guard that fails otherwise is an error and no plan", async () => {
  const { client } = await ready([
    ...specLoad(),
    json({ message: "Forbidden" }, { status: 403 }),
  ]);

  const { isError, text } = await call(client, "ct_api_request", {
    method: "DELETE",
    path: "/persons/12",
  });

  expect(isError).toBe(true);
  expect(text).toContain("Forbidden");
});

test("a DELETE without a GET in the spec has no guard and its preview shows the body", async () => {
  const { client, calls, requests } = await ready([
    ...specLoad(),
    json({ data: null }),
  ]);
  const body = { eventId: 5, eventServiceId: 9, comment: "ill" };

  const plan = await ok(client, "ct_api_request", {
    method: "DELETE",
    path: "/events/5/eventservices/9",
    body,
  });

  expect(plan.preview).toMatchObject({
    changes: [{ method: "DELETE", path: "/events/5/eventservices/9", body }],
  });
  expect(requests()).toHaveLength(2);
  calls.splice(0);

  await ok(client, "ct_execute_plan", { token: plan.token });

  expect(requests()).toEqual([`DELETE ${api}/events/5/eventservices/9`]);
  expect(calls[0]?.body).toEqual(body);
});

test("a DELETE preview shows the whole current record", async () => {
  const { client } = await ready([...specLoad(), json({ data: person })]);

  const plan = await ok(client, "ct_api_request", {
    method: "DELETE",
    path: "/persons/12",
  });

  expect(plan.preview).toMatchObject({
    changes: [{ method: "DELETE", record: person }],
  });
});

test("the server lists the generic tools with their annotations", async () => {
  const client = await connectClient({ env, fetch: fakeFetch().fetch });

  const { tools } = await client.listTools();
  const annotations = Object.fromEntries(
    tools.map((tool) => [tool.name, tool.annotations]),
  );

  expect(annotations.ct_search_api).toMatchObject({ readOnlyHint: true });
  expect(annotations.ct_get_operation).toMatchObject({ readOnlyHint: true });
  expect(annotations.ct_api_request).toMatchObject({
    readOnlyHint: false,
    destructiveHint: false,
  });
});

test("a literal segment beats a parameter, and its methods decide", async () => {
  const things = JSON.stringify({
    openapi: "3.1.0",
    info: { title: "Things", version: "0.1.0" },
    paths: {
      "/things/{id}": { get: { summary: "One" }, delete: { summary: "Drop" } },
      "/things/special": { get: { summary: "Special" } },
    },
  });
  const { client, requests } = await ready(specLoad(things));

  const operation = await ok(client, "ct_get_operation", {
    method: "GET",
    path: "/things/special",
  });
  const { isError, text } = await call(client, "ct_api_request", {
    method: "DELETE",
    path: "/things/special",
  });

  expect(operation).toMatchObject({ path: "/things/special" });
  expect(isError).toBe(true);
  expect(text).toContain("DELETE is not defined for /things/special");
  expect(requests()).toHaveLength(2);
});

test("parallel first calls share one load of the spec", async () => {
  const { client, requests } = await ready(specLoad());

  await Promise.all([
    ok(client, "ct_search_api", { query: "person" }),
    ok(client, "ct_search_api", { query: "group" }),
  ]);

  expect(requests()).toEqual([`GET ${api}/info`, `GET ${specPath}`]);
});

test("a POST returns a plan without guard and makes no GET and no write call", async () => {
  const { client, calls, requests } = await ready([
    ...specLoad(),
    json({ data: { id: 99 } }),
  ]);
  const body = { firstName: "Ann", lastName: "New", departmentIds: [1] };

  const plan = await ok(client, "ct_api_request", {
    method: "POST",
    path: "/persons",
    body,
  });

  expect(plan.preview).toMatchObject({
    changes: [{ method: "POST", path: "/persons" }],
  });
  expect(requests()).toEqual([`GET ${api}/info`, `GET ${specPath}`]);
  calls.splice(0);

  await ok(client, "ct_execute_plan", { token: plan.token });

  expect(requests()).toEqual([`POST ${api}/persons`]);
  expect(calls[0]?.body).toEqual(body);
});

const withSecrets = (() => {
  const { paths, ...rest } = JSON.parse(spec) as { paths: object };
  const get = { get: { summary: "Secret" }, post: { summary: "Secret" } };
  return JSON.stringify({
    ...rest,
    paths: {
      ...paths,
      "/login": get,
      "/login/totp": get,
      "/login/token": get,
      "/logout": get,
      "/csrftoken": get,
      "/persons/{personId}/logintoken": get,
      "/persons/{personId}/loginstring": get,
    },
  });
})();

test.each([
  ["GET", "/login"],
  ["POST", "/login"],
  ["POST", "/login/totp"],
  ["GET", "/login/token"],
  ["POST", "/logout"],
  ["GET", "/csrftoken"],
  ["GET", "/persons/12/logintoken"],
  ["POST", "/persons/12/logintoken"],
  ["GET", "/persons/12/loginstring"],
])(
  "ct_api_request refuses %s %s: login and secrets are not exposed",
  async (method, path) => {
    const { client, requests } = await ready(specLoad(withSecrets));

    const { isError, text } = await call(client, "ct_api_request", {
      method,
      path,
    });

    expect(isError).toBe(true);
    expect(text).toContain("not exposed");
    expect(text).toContain("ct_login");
    expect(requests()).toHaveLength(2);
  },
);

test("the client's own rate-limit error keeps its text in the tool result", async () => {
  const { client } = await ready([
    ...specLoad(),
    new Response("", { status: 429, headers: { "retry-after": "120" } }),
  ]);

  const { isError, text } = await call(client, "ct_api_request", {
    method: "GET",
    path: "/persons/12",
  });

  expect(isError).toBe(true);
  expect(text).toContain("120");
});
