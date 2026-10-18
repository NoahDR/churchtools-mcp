import { expect, test } from "vitest";
import { createSession, loginRequired } from "../src/ct/session.js";
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

async function messageOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected a failure");
}

function expectNoSecrets(text: string): void {
  for (const secret of secrets) expect(text).not.toContain(secret);
}

/** A fetch whose answers the test releases one by one, in any order. */
function gatedFetch() {
  const pending: {
    path: string;
    headers: Headers;
    answer: (response: Response | Error) => void;
  }[] = [];
  const fetch: typeof globalThis.fetch = (input, init = {}) =>
    new Promise((resolve, reject) => {
      const url = new URL(input instanceof Request ? input.url : input);
      pending.push({
        path: url.pathname,
        headers: new Headers(init.headers),
        answer: (response) =>
          response instanceof Error ? reject(response) : resolve(response),
      });
    });
  /** Answers the oldest open request to `path`. */
  async function answer(path: string, response: Response | Error) {
    await waitFor(() => pending.some((p) => p.path.endsWith(path)));
    const index = pending.findIndex((p) => p.path.endsWith(path));
    const [request] = pending.splice(index, 1);
    request?.answer(response);
    return request;
  }
  return { fetch, answer, pending };
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !condition(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  if (!condition()) throw new Error("condition not reached");
}

const loginWithCookie = (cookie: string) =>
  json(
    { data: { status: "totp", message: "", personId: 7 } },
    { headers: { "set-cookie": `ChurchTools_ct=${cookie}; Path=/` } },
  );
const anna = { id: 7, firstName: "Anna", lastName: "Admin" };

// Login answers

test("a /whoami that answers the anonymous user (id -1) fails the login", async () => {
  const [login, totp] = loginAnswers();
  const { fetch } = fakeFetch(
    login,
    totp,
    json({ data: { id: -1, firstName: "Anonymous", lastName: "" } }),
    json({ data: csrfToken }),
  );
  const session = createSession({ env, fetch });

  expect(await messageOf(session.login(code))).toContain("Login failed");
  expect(session.state()).toEqual({ state: "logged_out" });
});

test.each([
  ["a 500 with a text body", new Response("Internal error", { status: 500 })],
  ["a 200 with an HTML page", new Response("<html>login</html>")],
  ["a 200 without data", json({ status: "success" })],
  ["a 200 with an empty body", new Response("")],
])("/login answering %s fails and stays logged out", async (_, response) => {
  const { fetch, calls } = fakeFetch(response);
  const session = createSession({ env, fetch });

  const message = await messageOf(session.login(code));

  expect(message).toMatch(/^Login failed: /);
  expectNoSecrets(message);
  expect(calls).toHaveLength(1);
  expect(session.state()).toEqual({ state: "logged_out" });
});

test("an unknown /login status without a message names the status", async () => {
  const { fetch } = fakeFetch(json({ data: { status: "locked" } }));
  const session = createSession({ env, fetch });

  expect(await messageOf(session.login(code))).toBe(
    "Login failed: status locked",
  );
});

test.each([
  ["a 401", json({ message: "Session expired!" }, { status: 401 })],
  ["a 500", json({ message: "Server error" }, { status: 500 })],
  ["a number instead of a token", json({ data: 42 })],
])(
  "/csrftoken answering %s fails the login and stays logged out",
  async (_, response) => {
    const [login, totp, whoami] = loginAnswers();
    const { fetch } = fakeFetch(login, totp, whoami, response);
    const session = createSession({ env, fetch });

    const message = await messageOf(session.login(code));

    expect(message).toMatch(/^Login failed: /);
    expectNoSecrets(message);
    expect(session.state()).toEqual({ state: "logged_out" });
    expect(
      await messageOf(session.use((c) => c.request("GET", "/persons"))),
    ).toBe(loginRequired);
  },
);

test.each(["/login", "/login/totp", "/whoami", "/csrftoken"])(
  "a network error at %s fails the login and stays logged out",
  async (path) => {
    const answers = loginAnswers();
    const order = ["/login", "/login/totp", "/whoami", "/csrftoken"];
    const failAt = order.indexOf(path);
    let n = 0;
    const fetch: typeof globalThis.fetch = () =>
      n++ === failAt
        ? Promise.reject(new TypeError("fetch failed"))
        : Promise.resolve(answers[n - 1]);
    const session = createSession({ env, fetch });

    const message = await messageOf(session.login(code));

    expect(message).toBe(
      "Login failed: cannot reach example.org: fetch failed",
    );
    expect(session.state()).toEqual({ state: "logged_out" });
  },
);

test("a wrong code (totp 400) that echoes the code is redacted", async () => {
  const [login] = loginAnswers();
  const { fetch } = fakeFetch(
    login,
    json({ message: `Code ${code} is invalid` }, { status: 400 }),
  );
  const session = createSession({ env, fetch });

  const message = await messageOf(session.login(code));

  expect(message).toContain("is invalid");
  expectNoSecrets(message);
});

test("a server echo of a password with JSON special characters is redacted", async () => {
  const password = 'pa"55\\S3cret';
  const { fetch } = fakeFetch(
    new Response(JSON.stringify({ message: { detail: `bad ${password}` } }), {
      status: 400,
    }),
  );
  const session = createSession({
    env: { ...env, CT_PASSWORD: password },
    fetch,
  });

  const message = await messageOf(session.login(code));

  expect(message).not.toContain(password);
  expect(message).not.toContain(JSON.stringify(password).slice(1, -1));
});

test("a code with a leading zero is sent unchanged as a string", async () => {
  const { fetch, calls } = fakeFetch(...loginAnswers());
  const session = createSession({ env, fetch });

  await session.login("012345");

  expect(calls[1]?.body).toEqual({ code: "012345", personId: 7 });
});

// Re-login

test("a 401 on a later call, then a new login, works with the new cookie", async () => {
  const { fetch, calls } = fakeFetch(
    ...loginAnswers(),
    json({ message: "Session expired!" }, { status: 401 }),
    loginWithCookie("fresh-cookie"),
    json({ data: { status: "success" } }),
    json({ data: anna }),
    json({ data: "fresh-csrf" }),
    json({ data: {} }),
  );
  const session = createSession({ env, fetch });
  await session.login(code);
  await messageOf(session.use((c) => c.request("GET", "/persons")));

  await session.login(code);
  await session.use((c) => c.request("PATCH", "/persons/1", { body: {} }));

  const last = calls.at(-1);
  expect(session.state()).toMatchObject({ state: "ready" });
  expect(last?.headers.get("cookie")).toBe("ChurchTools_ct=fresh-cookie");
  expect(last?.headers.get("csrf-token")).toBe("fresh-csrf");
});

test("an old cookie is not sent after a re-login", async () => {
  const { fetch, calls } = fakeFetch(
    ...loginAnswers(),
    json({ message: "Wrong username or password" }, { status: 400 }),
  );
  const session = createSession({ env, fetch });
  await session.login(code);

  await messageOf(session.login(code));

  expect(calls.at(-1)?.headers.get("cookie")).toBeNull();
  expect(calls.at(-1)?.headers.get("cookie") ?? "").not.toContain(cookieValue);
});

// Concurrency

test("an earlier login finishing after a newer failed one leaves state and client in agreement", async () => {
  const gate = gatedFetch();
  const session = createSession({ env, fetch: gate.fetch });

  const first = session.login(code);
  await gate.answer("/login", loginWithCookie("cookie-A"));
  await gate.answer("/login/totp", json({ data: { status: "success" } }));
  const second = session.login(code);
  await gate.answer(
    "/login",
    json({ message: "Wrong username or password" }, { status: 400 }),
  );
  await messageOf(second);
  await gate.answer("/whoami", json({ data: anna }));
  await gate.answer("/csrftoken", json({ data: "csrf-A" }));
  await first;

  const used = session.use((c) => c.request("GET", "/persons"));
  const outcome = await Promise.race([
    used.then(
      () => "answered",
      (error: Error) => error.message,
    ),
    gate
      .answer("/persons", json({ data: [] }))
      .then((request) => request?.headers.get("cookie")),
  ]);

  // Either the session is logged out, or the call carries the cookie of the login that made it ready.
  expect([loginRequired, "ChurchTools_ct=cookie-A"]).toContain(outcome);
});

test("a 401 from a call started before a re-login does not log out the new session", async () => {
  const gate = gatedFetch();
  const session = createSession({ env, fetch: gate.fetch });
  const loggedIn = session.login(code);
  await gate.answer("/login", loginWithCookie("cookie-A"));
  await gate.answer("/login/totp", json({ data: { status: "success" } }));
  await gate.answer("/whoami", json({ data: anna }));
  await gate.answer("/csrftoken", json({ data: "csrf-A" }));
  await loggedIn;

  const oldCall = session.use((c) => c.request("GET", "/persons"));
  await waitFor(() => gate.pending.length === 1);
  const relogin = session.login(code);
  await gate.answer("/login", loginWithCookie("cookie-B"));
  await gate.answer("/login/totp", json({ data: { status: "success" } }));
  await gate.answer("/whoami", json({ data: anna }));
  await gate.answer("/csrftoken", json({ data: "csrf-B" }));
  await relogin;
  await gate.answer(
    "/persons",
    json({ message: "Session expired!" }, { status: 401 }),
  );
  await messageOf(oldCall);

  expect(session.state()).toMatchObject({ state: "ready", personId: 7 });
});

// Status

test("the status output never carries the cookie, the CSRF token, the password or the code", async () => {
  const { fetch } = fakeFetch(
    ...loginAnswers(),
    json({ version: "3", build: "1", siteName: "Demo" }),
  );
  const session = createSession({ env, fetch });
  const login = await session.login(code);

  const status = await session.status();

  expectNoSecrets(JSON.stringify(login));
  expectNoSecrets(JSON.stringify(status));
  expectNoSecrets(JSON.stringify(session.state()));
});

// After the fixes: redaction variants and status during a login

test("a password echoed with PHP's default JSON escaping of slashes is redacted", async () => {
  const password = "pa/55-S3cret";
  const { fetch } = fakeFetch(
    new Response('{"message":{"detail":"bad pa\\/55-S3cret"}}', {
      status: 400,
    }),
  );
  const session = createSession({
    env: { ...env, CT_PASSWORD: password },
    fetch,
  });

  const message = await messageOf(session.login(code));

  expect(message).not.toContain("S3cret");
});

test("a ct_status during a login in flight does not make it ready early or break it", async () => {
  const gate = gatedFetch();
  const session = createSession({ env, fetch: gate.fetch });
  const loggingIn = session.login(code);
  await gate.answer("/login", loginWithCookie("cookie-A"));

  const status = session.status();
  await gate.answer(
    "/info",
    json({ message: "Session expired!" }, { status: 401 }),
  );
  expect(await status).toMatchObject({ state: "logged_out" });
  await gate.answer("/login/totp", json({ data: { status: "success" } }));
  await gate.answer("/whoami", json({ data: anna }));
  await gate.answer("/csrftoken", json({ data: "csrf-A" }));

  expect(await loggingIn).toMatchObject({ state: "ready", personId: 7 });
  const used = session.use((c) => c.request("GET", "/persons"));
  const request = await gate.answer("/persons", json({ data: [] }));
  await used;
  expect(request?.headers.get("cookie")).toBe("ChurchTools_ct=cookie-A");
});

test("a 401 on /info while ready logs out and the status says so", async () => {
  const { fetch } = fakeFetch(
    ...loginAnswers(),
    json({ message: "Session expired!" }, { status: 401 }),
  );
  const session = createSession({ env, fetch });
  await session.login(code);

  const status = await session.status();

  expect(status).toMatchObject({
    state: "logged_out",
    instance: { error: "Session expired!" },
  });
  expect(session.state()).toEqual({ state: "logged_out" });
});
