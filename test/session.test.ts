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

const ready = { state: "ready", personId: 7, name: "Anna Admin" };

// Login

test("a login without 2FA skips /login/totp and ends ready", async () => {
  const { fetch, calls } = fakeFetch(...loginAnswers("success"));
  const session = createSession({ env, fetch });

  expect(await session.login(code)).toEqual(ready);
  expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
    "POST /churchtools/api/login",
    "GET /churchtools/api/whoami?only_allow_authenticated=true",
    "GET /churchtools/api/csrftoken",
  ]);
  expect(calls[0]?.body).toEqual({
    username: env.CT_USERNAME,
    password: env.CT_PASSWORD,
  });
});

test("a login with 2FA sends the code and the personId to /login/totp", async () => {
  const { fetch, calls } = fakeFetch(...loginAnswers("totp"));
  const session = createSession({ env, fetch });

  expect(await session.login(code)).toEqual(ready);
  expect(calls[1]).toMatchObject({
    method: "POST",
    path: "/churchtools/api/login/totp",
    body: { code, personId: 7 },
  });
  expect(calls[1]?.headers.get("cookie")).toBe(`ChurchTools_ct=${cookieValue}`);
  expect(session.state()).toEqual(ready);
});

test("the CSRF token from /csrftoken goes on later writes", async () => {
  const { fetch, calls } = fakeFetch(...loginAnswers(), json({ data: {} }));
  const session = createSession({ env, fetch });
  await session.login(code);

  await session.use((client) => client.request("PATCH", "/persons/1", {}));

  expect(calls.at(-1)?.headers.get("csrf-token")).toBe(csrfToken);
});

test.each([401, 403, 404])(
  "a wrong code (totp %i) fails with the server message and stays logged out",
  async (status) => {
    const [login] = loginAnswers();
    const { fetch } = fakeFetch(
      login,
      json(
        { message: "Invalid code", translatedMessage: "Der Code ist falsch" },
        { status },
      ),
    );
    const session = createSession({ env, fetch });

    const message = await messageOf(session.login(code));

    expect(message).toContain("Der Code ist falsch");
    expectNoSecrets(message);
    expect(session.state()).toEqual({ state: "logged_out" });
  },
);

test("a wrong password fails with the server message and stays logged out", async () => {
  const { fetch, calls } = fakeFetch(
    json({ message: "Wrong username or password" }, { status: 400 }),
  );
  const session = createSession({ env, fetch });

  const message = await messageOf(session.login(code));

  expect(message).toContain("Wrong username or password");
  expect(calls).toHaveLength(1);
  expect(session.state()).toEqual({ state: "logged_out" });
});

test("a raw text error body on the login path is replaced by its HTTP status", async () => {
  const { fetch } = fakeFetch(
    new Response(`bad login ${env.CT_PASSWORD} ${code}`, { status: 400 }),
  );
  const session = createSession({ env, fetch });

  const message = await messageOf(session.login(code));

  expect(message).toBe("Login failed: HTTP 400");
  expectNoSecrets(message);
});

test("an unknown /login status fails with its message", async () => {
  const { fetch } = fakeFetch(
    json({ data: { status: "locked", message: "Account locked" } }),
  );
  const session = createSession({ env, fetch });

  expect(await messageOf(session.login(code))).toContain("Account locked");
  expect(session.state()).toEqual({ state: "logged_out" });
});

test("a /login/totp answer other than success fails", async () => {
  const [login] = loginAnswers();
  const { fetch } = fakeFetch(login, json({ data: { status: "pending" } }));
  const session = createSession({ env, fetch });

  expect(await messageOf(session.login(code))).toContain("Login failed");
  expect(session.state()).toEqual({ state: "logged_out" });
});

test("a 401 from /whoami means the login did not stick", async () => {
  const [login, totp] = loginAnswers();
  const { fetch } = fakeFetch(
    login,
    totp,
    json({ message: "Session expired!" }, { status: 401 }),
  );
  const session = createSession({ env, fetch });

  expect(await messageOf(session.login(code))).toContain("Login failed");
  expect(session.state()).toEqual({ state: "logged_out" });
});

test("an invalid configuration fails the login by variable name without a request", async () => {
  const { fetch, calls } = fakeFetch();
  const session = createSession({ env: { ...env, CT_URL: "" }, fetch });

  const message = await messageOf(session.login(code));

  expect(message).toContain("CT_URL");
  expect(calls).toHaveLength(0);
});

test("a second login starts a fresh session", async () => {
  const anna = loginAnswers();
  const bert = loginAnswers("totp", {
    id: 9,
    firstName: "Bert",
    lastName: "B",
  });
  const { fetch, calls } = fakeFetch(...anna, ...bert);
  const session = createSession({ env, fetch });
  await session.login(code);

  expect(await session.login(code)).toEqual({
    state: "ready",
    personId: 9,
    name: "Bert B",
  });
  expect(calls[anna.length]?.headers.get("cookie")).toBeNull();
});

test("a failed second login leaves the session logged out", async () => {
  const { fetch } = fakeFetch(
    ...loginAnswers(),
    json({ message: "Wrong username or password" }, { status: 400 }),
  );
  const session = createSession({ env, fetch });
  await session.login(code);

  await messageOf(session.login(code));

  expect(session.state()).toEqual({ state: "logged_out" });
});

// Using the session

test("a call without a login asks for the 2FA code and sends nothing", async () => {
  const { fetch, calls } = fakeFetch();
  const session = createSession({ env, fetch });

  const message = await messageOf(
    session.use((client) => client.request("GET", "/persons")),
  );

  expect(message).toBe(loginRequired);
  expect(calls).toHaveLength(0);
});

test("a 401 on a later call resets the state and asks for the 2FA code", async () => {
  const { fetch } = fakeFetch(
    ...loginAnswers(),
    json({ message: "Session expired!" }, { status: 401 }),
  );
  const session = createSession({ env, fetch });
  await session.login(code);

  const message = await messageOf(
    session.use((client) => client.request("GET", "/persons")),
  );

  expect(message).toBe(loginRequired);
  expect(message).toContain("2FA code");
  expect(message).toContain("ct_login");
  expect(session.state()).toEqual({ state: "logged_out" });
});

test("another error on a later call keeps the session", async () => {
  const { fetch } = fakeFetch(
    ...loginAnswers(),
    json({ message: "Forbidden" }, { status: 403 }),
  );
  const session = createSession({ env, fetch });
  await session.login(code);

  const message = await messageOf(
    session.use((client) => client.request("GET", "/persons")),
  );

  expect(message).toBe("Forbidden");
  expect(session.state()).toEqual(ready);
});

// Status

const info = () =>
  json({
    version: "3.137.1",
    build: "4711",
    siteName: "Demo",
    shortName: "D",
  });
const instance = { version: "3.137.1", build: "4711", siteName: "Demo" };

test("the status of a ready session names the user and the instance", async () => {
  const { fetch, calls } = fakeFetch(...loginAnswers(), info());
  const session = createSession({ env, fetch });
  await session.login(code);

  const status = await session.status();

  expect(status).toEqual({ configValid: true, ...ready, instance });
  expect(calls.at(-1)?.path).toBe("/churchtools/api/info");
  expectNoSecrets(JSON.stringify(status));
});

test("the status without a login says logged_out and names the instance", async () => {
  const { fetch } = fakeFetch(info());
  const session = createSession({ env, fetch });

  expect(await session.status()).toEqual({
    configValid: true,
    state: "logged_out",
    instance,
  });
});

test("the status with an invalid configuration names the variable without a request", async () => {
  const { fetch, calls } = fakeFetch();
  const session = createSession({
    env: { ...env, CT_PASSWORD: undefined },
    fetch,
  });

  const status = await session.status();

  expect(status).toEqual({
    configValid: false,
    configError: "Configuration: CT_PASSWORD is missing",
    state: "logged_out",
  });
  expect(calls).toHaveLength(0);
});

test("a 401 from /info in the status logs out and reports logged_out", async () => {
  const { fetch } = fakeFetch(
    ...loginAnswers(),
    json({ message: "Session expired!" }, { status: 401 }),
  );
  const session = createSession({ env, fetch });
  await session.login(code);

  expect(await session.status()).toEqual({
    configValid: true,
    state: "logged_out",
    instance: { error: "Session expired!" },
  });
  expect(session.state()).toEqual({ state: "logged_out" });
});
