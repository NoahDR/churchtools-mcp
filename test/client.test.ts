import { afterEach, expect, test, vi } from "vitest";
import {
  CtError,
  SessionExpiredError,
  createCtClient,
} from "../src/ct/client.js";

const baseUrl = "https://example.org/churchtools";
const cookieValue = "c00kie-S3cret";
const csrfToken = "csrf-T0ken-S3cret";

interface Call {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

/** A fake fetch that answers with the queued responses in order. */
function fakeFetch(...responses: Response[]) {
  const calls: Call[] = [];
  const fetch: typeof globalThis.fetch = (input, init = {}) => {
    calls.push({
      url: input instanceof Request ? input.url : input.toString(),
      method: init.method ?? "GET",
      headers: new Headers(init.headers),
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const response = responses.shift();
    if (!response) throw new Error("no response queued");
    return Promise.resolve(response);
  };
  return { fetch, calls };
}

function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(body), { ...init, headers });
}

function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected the request to fail");
    },
    (error: unknown) => error,
  );
}

afterEach(() => {
  vi.useRealTimers();
});

test("a request goes to <baseUrl>/api<path> with its query", async () => {
  const { fetch, calls } = fakeFetch(json({ data: [] }));
  const client = createCtClient({ baseUrl, fetch });

  await client.request("GET", "/persons", {
    query: { query: "Anna Müller", "ids[]": [1, 2], is_archived: false },
  });

  expect(calls[0]?.url).toBe(
    "https://example.org/churchtools/api/persons?query=Anna+M%C3%BCller&ids%5B%5D=1&ids%5B%5D=2&is_archived=false",
  );
});

test("an undefined query value is left out", async () => {
  const { fetch, calls } = fakeFetch(json({ data: [] }));
  const client = createCtClient({ baseUrl, fetch });

  await client.request("GET", "/persons", { query: { email: undefined } });

  expect(calls[0]?.url).toBe("https://example.org/churchtools/api/persons");
});

test("a JSON body is sent and the JSON answer returned", async () => {
  const { fetch, calls } = fakeFetch(json({ data: { id: 7 } }));
  const client = createCtClient({ baseUrl, fetch });

  const answer = await client.request("POST", "/groups", {
    body: { name: "Choir" },
  });

  expect(answer).toEqual({ data: { id: 7 } });
  expect(calls[0]?.body).toEqual({ name: "Choir" });
  expect(calls[0]?.headers.get("content-type")).toBe("application/json");
});

test("an empty answer returns undefined", async () => {
  const { fetch } = fakeFetch(new Response(null, { status: 204 }));
  const client = createCtClient({ baseUrl, fetch });

  expect(await client.request("DELETE", "/groups/7")).toBeUndefined();
});

test("cookies set by an answer are sent back on the next request", async () => {
  const setCookies = new Headers([
    ["set-cookie", `ChurchTools_ct_x=${cookieValue}; path=/; HttpOnly`],
    ["set-cookie", "lang=de"],
  ]);
  const { fetch, calls } = fakeFetch(
    json({ data: {} }, { headers: setCookies }),
    json({ data: {} }),
  );
  const client = createCtClient({ baseUrl, fetch });

  await client.request("POST", "/login", { body: { username: "admin" } });
  await client.request("GET", "/whoami");

  expect(calls[0]?.headers.get("cookie")).toBeNull();
  expect(calls[1]?.headers.get("cookie")).toBe(
    `ChurchTools_ct_x=${cookieValue}; lang=de`,
  );
});

test("a cookie set again replaces its old value", async () => {
  const { fetch, calls } = fakeFetch(
    json({}, { headers: { "set-cookie": "session=old" } }),
    json({}, { headers: { "set-cookie": "session=new" } }),
    json({}),
  );
  const client = createCtClient({ baseUrl, fetch });

  await client.request("GET", "/a");
  await client.request("GET", "/b");
  await client.request("GET", "/c");

  expect(calls[2]?.headers.get("cookie")).toBe("session=new");
});

test("the CSRF token is sent on a PATCH", async () => {
  const { fetch, calls } = fakeFetch(json({ data: {} }));
  const client = createCtClient({ baseUrl, fetch });
  client.setCsrfToken(csrfToken);

  await client.request("PATCH", "/persons/7", { body: { firstName: "A" } });

  expect(calls[0]?.headers.get("csrf-token")).toBe(csrfToken);
});

test.each([
  ["GET", "/persons"],
  ["POST", "/login"],
  ["POST", "/login/totp"],
] as const)("the CSRF token is not sent on %s %s", async (method, path) => {
  const { fetch, calls } = fakeFetch(json({ data: {} }));
  const client = createCtClient({ baseUrl, fetch });
  client.setCsrfToken(csrfToken);

  await client.request(method, path);

  expect(calls[0]?.headers.get("csrf-token")).toBeNull();
});

test("no CSRF header is sent before a token is set", async () => {
  const { fetch, calls } = fakeFetch(json({ data: {} }));
  const client = createCtClient({ baseUrl, fetch });

  await client.request("DELETE", "/groups/7");

  expect(calls[0]?.headers.has("csrf-token")).toBe(false);
});

test("a JSON error body becomes a CtError with the translated message", async () => {
  const errors = [{ fieldId: "name", message: "required", messageKey: "x" }];
  const { fetch } = fakeFetch(
    json(
      {
        message: "Bad request",
        translatedMessage: "Ungültige Anfrage",
        messageKey: "error.validation",
        args: [],
        errors,
      },
      { status: 400 },
    ),
  );
  const client = createCtClient({ baseUrl, fetch });

  const error = await rejectionOf(client.request("POST", "/groups"));

  expect(error).toBeInstanceOf(CtError);
  expect(error).toMatchObject({
    status: 400,
    message: "Ungültige Anfrage",
    messageKey: "error.validation",
    errors,
  });
});

test("a malformed errors[] entry keeps the translated message", async () => {
  const { fetch } = fakeFetch(
    json(
      {
        message: "Bad request",
        translatedMessage: "Ungültige Anfrage",
        errors: [{ fieldId: null, message: "required" }],
      },
      { status: 400 },
    ),
  );
  const client = createCtClient({ baseUrl, fetch });

  await expect(client.request("POST", "/groups")).rejects.toMatchObject({
    message: "Ungültige Anfrage",
  });
});

test("a non-object errors[] entry drops only itself, the other field errors stay", async () => {
  const { fetch } = fakeFetch(
    json(
      {
        message: "Bad request",
        errors: ["junk", { fieldId: "name", message: "required" }],
      },
      { status: 400 },
    ),
  );
  const client = createCtClient({ baseUrl, fetch });

  await expect(client.request("POST", "/groups")).rejects.toMatchObject({
    errors: [{ fieldId: "name", message: "required" }],
  });
});

test("a server that never answers fails after the timeout, naming the host", async () => {
  const fetch: typeof globalThis.fetch = (_input, init = {}) =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () =>
        reject(init.signal?.reason as Error),
      );
    });
  const client = createCtClient({ baseUrl, fetch, timeoutMs: 20 });

  await expect(client.request("GET", "/whoami")).rejects.toThrow(
    "example.org did not answer within 0.02 s",
  );
});

test("the args of an error body are kept on the CtError", async () => {
  const { fetch } = fakeFetch(
    json(
      { message: "Duplicate", args: { duplicatePersonId: 42 } },
      { status: 400 },
    ),
  );
  const client = createCtClient({ baseUrl, fetch });

  await expect(client.request("POST", "/persons")).rejects.toMatchObject({
    args: { duplicatePersonId: 42 },
  });
});

test("a JSON error body without a translation uses its message", async () => {
  const { fetch } = fakeFetch(json({ message: "Not found" }, { status: 404 }));
  const client = createCtClient({ baseUrl, fetch });

  await expect(client.request("GET", "/persons/9")).rejects.toMatchObject({
    status: 404,
    message: "Not found",
  });
});

test("a text error body becomes the error message", async () => {
  const { fetch } = fakeFetch(
    new Response("Internal failure", {
      status: 500,
      headers: { "content-type": "text/plain" },
    }),
  );
  const client = createCtClient({ baseUrl, fetch });

  await expect(client.request("GET", "/persons")).rejects.toMatchObject({
    status: 500,
    message: "Internal failure",
  });
});

test("an empty error body yields a message with the status", async () => {
  const { fetch } = fakeFetch(new Response(null, { status: 502 }));
  const client = createCtClient({ baseUrl, fetch });

  await expect(client.request("GET", "/persons")).rejects.toMatchObject({
    status: 502,
    message: "ChurchTools answered HTTP 502",
  });
});

test("a 401 becomes a SessionExpiredError", async () => {
  const { fetch } = fakeFetch(
    json(
      { message: "Session expired!", messageKey: "exception.unauthorized" },
      { status: 401 },
    ),
  );
  const client = createCtClient({ baseUrl, fetch });

  const error = await rejectionOf(client.request("GET", "/whoami"));

  expect(error).toBeInstanceOf(SessionExpiredError);
  expect(error).toMatchObject({ status: 401, message: "Session expired!" });
});

test("a text/plain 401 becomes a SessionExpiredError", async () => {
  const { fetch } = fakeFetch(new Response("Unauthorized", { status: 401 }));
  const client = createCtClient({ baseUrl, fetch });

  await expect(client.request("GET", "/whoami")).rejects.toBeInstanceOf(
    SessionExpiredError,
  );
});

test("no error carries the cookie or the CSRF token", async () => {
  const { fetch } = fakeFetch(
    json({}, { headers: { "set-cookie": `session=${cookieValue}` } }),
    json({ message: "Forbidden" }, { status: 403 }),
  );
  const client = createCtClient({ baseUrl, fetch });
  client.setCsrfToken(csrfToken);
  await client.request("GET", "/whoami");

  const error = await rejectionOf(client.request("PATCH", "/persons/7"));
  const text = `${String(error)} ${JSON.stringify(error)} ${(error as Error).stack}`;

  expect(text).not.toContain(cookieValue);
  expect(text).not.toContain(csrfToken);
});

test("a 429 with Retry-After is retried once after that many seconds", async () => {
  vi.useFakeTimers();
  const { fetch, calls } = fakeFetch(
    new Response(null, { status: 429, headers: { "retry-after": "2" } }),
    json({ data: "ok" }),
  );
  const client = createCtClient({ baseUrl, fetch });

  const answer = client.request("POST", "/groups", { body: { name: "A" } });
  await vi.advanceTimersByTimeAsync(1999);
  expect(calls).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);

  expect(await answer).toEqual({ data: "ok" });
  expect(calls[1]?.body).toEqual({ name: "A" });
});

test("a 429 without Retry-After is retried once after 30 seconds", async () => {
  vi.useFakeTimers();
  const { fetch, calls } = fakeFetch(
    new Response(null, { status: 429 }),
    json({ data: "ok" }),
  );
  const client = createCtClient({ baseUrl, fetch });

  const answer = client.request("GET", "/persons");
  await vi.advanceTimersByTimeAsync(29_999);
  expect(calls).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);

  expect(await answer).toEqual({ data: "ok" });
});

test("a second 429 is an error, not another retry", async () => {
  vi.useFakeTimers();
  const { fetch, calls } = fakeFetch(
    new Response(null, { status: 429, headers: { "retry-after": "1" } }),
    new Response("Too many requests", { status: 429 }),
  );
  const client = createCtClient({ baseUrl, fetch });

  const failure = expect(
    client.request("GET", "/persons"),
  ).rejects.toMatchObject({ status: 429, message: "Too many requests" });
  await vi.advanceTimersByTimeAsync(1000);

  await failure;
  expect(calls).toHaveLength(2);
});

test("a 429 asking for more than 30 seconds fails at once", async () => {
  vi.useFakeTimers();
  const { fetch, calls } = fakeFetch(
    new Response(null, { status: 429, headers: { "retry-after": "31" } }),
  );
  const client = createCtClient({ baseUrl, fetch });

  await expect(client.request("GET", "/persons")).rejects.toMatchObject({
    status: 429,
    message: "Rate limited; retry after 31 s",
  });
  expect(calls).toHaveLength(1);
});

function page(ids: number[], current: number, lastPage: number): Response {
  return json({
    data: ids.map((id) => ({ id })),
    meta: { pagination: { current, lastPage, limit: 100, total: 250 } },
  });
}

function range(from: number, count: number): number[] {
  return Array.from({ length: count }, (_, index) => from + index);
}

test("getAll follows the pages until the last one", async () => {
  const { fetch, calls } = fakeFetch(
    page(range(1, 100), 1, 3),
    page(range(101, 100), 2, 3),
    page(range(201, 50), 3, 3),
  );
  const client = createCtClient({ baseUrl, fetch });

  const items = await client.getAll("/persons", { is_archived: false });

  expect(items).toHaveLength(250);
  expect(items[249]).toEqual({ id: 250 });
  expect(calls.map((call) => new URL(call.url).search)).toEqual([
    "?is_archived=false&page=1&limit=100",
    "?is_archived=false&page=2&limit=100",
    "?is_archived=false&page=3&limit=100",
  ]);
});

test("getAll stops at max records", async () => {
  const { fetch, calls } = fakeFetch(
    page(range(1, 100), 1, 5),
    page(range(101, 100), 2, 5),
  );
  const client = createCtClient({ baseUrl, fetch });

  const items = await client.getAll("/persons", {}, 150);

  expect(items).toHaveLength(150);
  expect(calls).toHaveLength(2);
});

test("getAll reads a list without pagination as one page", async () => {
  const { fetch, calls } = fakeFetch(json({ data: [{ id: 1 }] }));
  const client = createCtClient({ baseUrl, fetch });

  expect(await client.getAll("/calendars")).toEqual([{ id: 1 }]);
  expect(calls).toHaveLength(1);
});

test("an unreachable host is named with the network cause", async () => {
  const cause = Object.assign(new Error("getaddrinfo ENOTFOUND example.org"), {
    code: "ENOTFOUND",
  });
  const fetch: typeof globalThis.fetch = () =>
    Promise.reject(new TypeError("fetch failed", { cause }));
  const client = createCtClient({ baseUrl, fetch });

  await expect(client.request("GET", "/whoami")).rejects.toThrow(
    "cannot reach example.org: ENOTFOUND",
  );
});
