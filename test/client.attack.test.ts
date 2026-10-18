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
}

/** A fake fetch that answers with the queued responses in order. */
function fakeFetch(...responses: Response[]) {
  const calls: Call[] = [];
  const fetch: typeof globalThis.fetch = (input, init = {}) => {
    calls.push({
      url: input instanceof Request ? input.url : input.toString(),
      method: init.method ?? "GET",
      headers: new Headers(init.headers),
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

function errorText(error: unknown): string {
  return `${String(error)} ${JSON.stringify(error)} ${(error as Error).stack}`;
}

afterEach(() => {
  vi.useRealTimers();
});

// Cookies

test("cookie attributes are dropped and a value with '=' is kept whole", async () => {
  const setCookies = new Headers([
    [
      "set-cookie",
      "token=abc==; Path=/; Expires=Wed, 21 Oct 2037 07:28:00 GMT; Secure; HttpOnly; SameSite=Lax",
    ],
    ["set-cookie", "lang=de; Path=/"],
    ["set-cookie", `ChurchTools_ct_x=${cookieValue}; Domain=example.org`],
  ]);
  const { fetch, calls } = fakeFetch(
    json({}, { headers: setCookies }),
    json({}),
  );
  const client = createCtClient({ baseUrl, fetch });

  await client.request("GET", "/a");
  await client.request("GET", "/b");

  expect(calls[1]?.headers.get("cookie")).toBe(
    `token=abc==; lang=de; ChurchTools_ct_x=${cookieValue}`,
  );
});

test("a cookie set with Max-Age=0 is no longer sent", async () => {
  const { fetch, calls } = fakeFetch(
    json({}, { headers: { "set-cookie": "session=abc" } }),
    json({}, { headers: { "set-cookie": "session=deleted; Max-Age=0" } }),
    json({}),
  );
  const client = createCtClient({ baseUrl, fetch });

  await client.request("GET", "/a");
  await client.request("POST", "/logout");
  await client.request("GET", "/c");

  expect(calls[2]?.headers.get("cookie")).toBeNull();
});

test("a cookie set with an Expires date in the past is no longer sent", async () => {
  const { fetch, calls } = fakeFetch(
    json({}, { headers: { "set-cookie": "session=abc" } }),
    json(
      {},
      {
        headers: {
          "set-cookie":
            "session=deleted; Expires=Thu, 01 Jan 1970 00:00:01 GMT",
        },
      },
    ),
    json({}),
  );
  const client = createCtClient({ baseUrl, fetch });

  await client.request("GET", "/a");
  await client.request("POST", "/logout");
  await client.request("GET", "/c");

  expect(calls[2]?.headers.get("cookie")).toBeNull();
});

test("a cookie set by an error answer is kept", async () => {
  const { fetch, calls } = fakeFetch(
    json(
      { message: "Wrong code" },
      { status: 401, headers: { "set-cookie": `session=${cookieValue}` } },
    ),
    json({}),
  );
  const client = createCtClient({ baseUrl, fetch });

  await rejectionOf(client.request("POST", "/login/totp"));
  await client.request("GET", "/whoami");

  expect(calls[1]?.headers.get("cookie")).toBe(`session=${cookieValue}`);
});

test("a cookie set by a 429 answer is sent on the retry", async () => {
  vi.useFakeTimers();
  const { fetch, calls } = fakeFetch(
    new Response(null, {
      status: 429,
      headers: { "retry-after": "0", "set-cookie": "session=fresh" },
    }),
    json({}),
  );
  const client = createCtClient({ baseUrl, fetch });

  const answer = client.request("GET", "/persons");
  await vi.advanceTimersByTimeAsync(0);
  await answer;

  expect(calls[1]?.headers.get("cookie")).toBe("session=fresh");
});

// CSRF

test.each([
  ["POST", "/groups"],
  ["PUT", "/calendars/1/appointments/2"],
  ["DELETE", "/groups/7"],
  ["POST", "/logout"],
  ["POST", "/login/token"],
] as const)("the CSRF token is sent on %s %s", async (method, path) => {
  const { fetch, calls } = fakeFetch(json({}));
  const client = createCtClient({ baseUrl, fetch });
  client.setCsrfToken(csrfToken);

  await client.request(method, path);

  expect(calls[0]?.headers.get("csrf-token")).toBe(csrfToken);
});

test("a new CSRF token replaces the old one", async () => {
  const { fetch, calls } = fakeFetch(json({}));
  const client = createCtClient({ baseUrl, fetch });
  client.setCsrfToken("old-token");
  client.setCsrfToken(csrfToken);

  await client.request("PATCH", "/persons/7");

  expect(calls[0]?.headers.get("csrf-token")).toBe(csrfToken);
});

// Error mapping

test.each([403, 404, 500])(
  "a %i is a CtError but not a SessionExpiredError",
  async (status) => {
    const { fetch } = fakeFetch(json({ message: "No" }, { status }));
    const client = createCtClient({ baseUrl, fetch });

    const error = await rejectionOf(client.request("GET", "/persons/1"));

    expect(error).toBeInstanceOf(CtError);
    expect(error).not.toBeInstanceOf(SessionExpiredError);
    expect(error).toMatchObject({ status, message: "No" });
  },
);

test("an HTML error page becomes the error message", async () => {
  const html = "<html><body>Not Found</body></html>";
  const { fetch } = fakeFetch(
    new Response(html, {
      status: 404,
      headers: { "content-type": "text/html" },
    }),
  );
  const client = createCtClient({ baseUrl, fetch });

  await expect(client.request("GET", "/nope")).rejects.toMatchObject({
    status: 404,
    message: html,
  });
});

test("a field error in the spec shape keeps fieldId, message and messageKey", async () => {
  const { fetch } = fakeFetch(
    json(
      {
        message: "Validation failed",
        messageKey: "error.validation",
        args: [{ name: "duplicatePersonId", value: "12" }],
        errors: [
          {
            fieldId: "email",
            message: "invalid",
            messageKey: "error.email",
            value: "x@",
            args: { name: "email", value: "x@" },
          },
        ],
      },
      { status: 400 },
    ),
  );
  const client = createCtClient({ baseUrl, fetch });

  const error = await rejectionOf(client.request("POST", "/persons"));

  expect(error).toMatchObject({
    status: 400,
    message: "Validation failed",
    errors: [
      { fieldId: "email", message: "invalid", messageKey: "error.email" },
    ],
  });
});

test("a 401 keeps the messageKey on the SessionExpiredError", async () => {
  const { fetch } = fakeFetch(
    json(
      { message: "Session expired!", messageKey: "exception.unauthorized" },
      { status: 401 },
    ),
  );
  const client = createCtClient({ baseUrl, fetch });

  await expect(client.request("GET", "/whoami")).rejects.toMatchObject({
    name: "SessionExpiredError",
    messageKey: "exception.unauthorized",
  });
});

test.each([
  ["a 401", () => json({ message: "Session expired!" }, { status: 401 })],
  ["a text 404", () => new Response("Not found", { status: 404 })],
  ["an empty 500", () => new Response(null, { status: 500 })],
  [
    "a 429 asking for an hour",
    () =>
      new Response(null, { status: 429, headers: { "retry-after": "3600" } }),
  ],
] as const)(
  "%s carries neither the cookie nor the CSRF token",
  async (_, answer) => {
    const { fetch } = fakeFetch(
      json({}, { headers: { "set-cookie": `session=${cookieValue}` } }),
      answer(),
    );
    const client = createCtClient({ baseUrl, fetch });
    client.setCsrfToken(csrfToken);
    await client.request("GET", "/whoami");

    const error = await rejectionOf(
      client.request("POST", "/groups", { body: { name: "A" } }),
    );

    expect(error).toBeInstanceOf(CtError);
    expect(errorText(error)).not.toContain(cookieValue);
    expect(errorText(error)).not.toContain(csrfToken);
  },
);

// 429

test("a 429 with Retry-After 0 is retried without waiting", async () => {
  vi.useFakeTimers();
  const { fetch, calls } = fakeFetch(
    new Response(null, { status: 429, headers: { "retry-after": "0" } }),
    json({ data: "ok" }),
  );
  const client = createCtClient({ baseUrl, fetch });

  const answer = client.request("GET", "/persons");
  await vi.advanceTimersByTimeAsync(0);

  expect(calls).toHaveLength(2);
  expect(await answer).toEqual({ data: "ok" });
});

test("a 429 with Retry-After 30 waits the full 30 seconds", async () => {
  vi.useFakeTimers();
  const { fetch, calls } = fakeFetch(
    new Response(null, { status: 429, headers: { "retry-after": " 30 " } }),
    json({ data: "ok" }),
  );
  const client = createCtClient({ baseUrl, fetch });

  const answer = client.request("GET", "/persons");
  await vi.advanceTimersByTimeAsync(29_999);
  expect(calls).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);

  expect(await answer).toEqual({ data: "ok" });
});

test.each([
  ["an HTTP date", "Wed, 21 Oct 2037 07:28:00 GMT"],
  ["a negative number", "-5"],
  ["a fraction", "1.5"],
  ["an empty value", ""],
])(
  "a 429 with %s as Retry-After falls back to 30 seconds",
  async (_, header) => {
    vi.useFakeTimers();
    const { fetch, calls } = fakeFetch(
      new Response(null, { status: 429, headers: { "retry-after": header } }),
      json({ data: "ok" }),
    );
    const client = createCtClient({ baseUrl, fetch });

    const answer = client.request("GET", "/persons");
    await vi.advanceTimersByTimeAsync(29_999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(await answer).toEqual({ data: "ok" });
  },
);

test("a 429 asking for an hour fails without waiting", async () => {
  vi.useFakeTimers();
  const { fetch, calls } = fakeFetch(
    new Response(null, { status: 429, headers: { "retry-after": "3600" } }),
  );
  const client = createCtClient({ baseUrl, fetch });

  await expect(client.request("GET", "/persons")).rejects.toMatchObject({
    status: 429,
  });
  expect(vi.getTimerCount()).toBe(0);
  expect(calls).toHaveLength(1);
});

test("a 401 on the retry after a 429 is a SessionExpiredError", async () => {
  vi.useFakeTimers();
  const { fetch } = fakeFetch(
    new Response(null, { status: 429, headers: { "retry-after": "0" } }),
    json({ message: "Session expired!" }, { status: 401 }),
  );
  const client = createCtClient({ baseUrl, fetch });

  const failure = rejectionOf(client.request("GET", "/whoami"));
  await vi.advanceTimersByTimeAsync(0);

  expect(await failure).toBeInstanceOf(SessionExpiredError);
});

// getAll

function page(ids: number[], current: number, lastPage: number): Response {
  return json({
    data: ids.map((id) => ({ id })),
    meta: { pagination: { current, lastPage } },
  });
}

function range(from: number, count: number): number[] {
  return Array.from({ length: count }, (_, index) => from + index);
}

test("getAll reads a list with meta.count and no pagination as one page", async () => {
  // GET /calendars, /events and /campuses answer meta {count} [spec MetaCount].
  const { fetch, calls } = fakeFetch(
    json({ data: [{ id: 1 }, { id: 2 }], meta: { count: 2 } }),
  );
  const client = createCtClient({ baseUrl, fetch });

  expect(await client.getAll("/calendars")).toEqual([{ id: 1 }, { id: 2 }]);
  expect(calls).toHaveLength(1);
});

test("getAll stops on an empty first page with lastPage 0", async () => {
  const { fetch, calls } = fakeFetch(page([], 1, 0));
  const client = createCtClient({ baseUrl, fetch });

  expect(await client.getAll("/persons")).toEqual([]);
  expect(calls).toHaveLength(1);
});

test("getAll with max below one page returns max records from one request", async () => {
  const { fetch, calls } = fakeFetch(page(range(1, 100), 1, 5));
  const client = createCtClient({ baseUrl, fetch });

  const items = await client.getAll("/persons", {}, 5);

  expect(items).toEqual(range(1, 5).map((id) => ({ id })));
  expect(calls).toHaveLength(1);
});

test("getAll with max 0 sends no request", async () => {
  const { fetch, calls } = fakeFetch();
  const client = createCtClient({ baseUrl, fetch });

  expect(await client.getAll("/persons", {}, 0)).toEqual([]);
  expect(calls).toHaveLength(0);
});

test("getAll stops at max when the server ignores the page parameter", async () => {
  const { fetch, calls } = fakeFetch(
    page(range(1, 100), 1, 9),
    page(range(1, 100), 1, 9),
    page(range(1, 100), 1, 9),
  );
  const client = createCtClient({ baseUrl, fetch });

  const items = await client.getAll("/persons", {}, 250);

  expect(items).toHaveLength(250);
  expect(calls).toHaveLength(3);
});

test("getAll keeps the caller's array query on every page under the subpath", async () => {
  const { fetch, calls } = fakeFetch(
    page(range(1, 100), 1, 2),
    page(range(101, 1), 2, 2),
  );
  const client = createCtClient({ baseUrl, fetch });

  await client.getAll("/persons", { "ids[]": [3, 4], limit: 10 });

  expect(calls.map((call) => call.url)).toEqual([
    "https://example.org/churchtools/api/persons?ids%5B%5D=3&ids%5B%5D=4&limit=100&page=1",
    "https://example.org/churchtools/api/persons?ids%5B%5D=3&ids%5B%5D=4&limit=100&page=2",
  ]);
});

test("a redirect is refused, so the login body never reaches another host", async () => {
  const { createServer } = await import("node:http");
  const received: string[] = [];
  const other = createServer((req, res) => {
    received.push(`${req.method} ${req.url}`);
    res.end("{}");
  });
  await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
  const otherPort = (other.address() as { port: number }).port;
  const instance = createServer((_req, res) => {
    res.writeHead(307, { location: `http://127.0.0.1:${otherPort}/steal` });
    res.end();
  });
  await new Promise<void>((resolve) =>
    instance.listen(0, "127.0.0.1", resolve),
  );
  const instancePort = (instance.address() as { port: number }).port;
  try {
    const client = createCtClient({
      baseUrl: `http://127.0.0.1:${instancePort}`,
      fetch: globalThis.fetch,
    });

    const error = await rejectionOf(
      client.request("POST", "/login", { body: { password: "pa55-S3cret" } }),
    );

    expect(String(error)).toContain("redirect");
    expect(received).toEqual([]);
  } finally {
    instance.close();
    other.close();
  }
});
