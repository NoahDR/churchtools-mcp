import { z } from "zod";
import { type Config, readConfig } from "../config.js";
import {
  type CtClient,
  SessionExpiredError,
  createCtClient,
  errorText,
  parse,
} from "./client.js";

export type SessionState =
  { state: "logged_out" } | { state: "ready"; personId: number; name: string };

export const loginRequired =
  "Not logged in to ChurchTools, or the session expired. Ask the user for the current 2FA code and call ct_login with it.";

const loginSchema = z.object({
  data: z.object({
    status: z.string(),
    message: z.string().nullish(),
    personId: z.number().nullish(),
  }),
});
const totpSchema = z.object({ data: z.object({ status: z.string() }) });
const whoamiSchema = z.object({
  data: z.object({
    id: z.number(),
    firstName: z.string(),
    lastName: z.string(),
  }),
});
const csrfSchema = z.object({ data: z.string() });
/** /info answers without the usual `data` envelope. */
const infoSchema = z.object({
  version: z.string(),
  build: z.string(),
  siteName: z.string(),
});

/** Covers the plain and the JSON-escaped form, as a server message may echo either. */
function redact(text: string, secrets: string[]): string {
  return secrets
    .filter((secret) => secret.length > 0)
    .flatMap((secret) => [secret, JSON.stringify(secret).slice(1, -1)])
    .reduce((result, secret) => result.replaceAll(secret, "***"), text);
}

/** Login state and the client of one ChurchTools session; secrets stay in here. */
export function createSession({
  env,
  fetch,
}: {
  env: NodeJS.ProcessEnv;
  fetch: typeof globalThis.fetch;
}) {
  const config = readConfig(env);
  const newClient = (baseUrl: string) => createCtClient({ baseUrl, fetch });
  let client: CtClient | undefined;
  let state: SessionState = { state: "logged_out" };

  async function signIn(
    fresh: CtClient,
    { username, password }: Config,
    code: string,
  ) {
    const login = parse(
      loginSchema,
      await fresh.request("POST", "/login", { body: { username, password } }),
      "/login",
    ).data;
    if (login.status === "totp") {
      if (!code)
        throw new Error(
          "This account needs a 2FA code: ask the user for the current code and call ct_login with it.",
        );
      const totp = parse(
        totpSchema,
        await fresh.request("POST", "/login/totp", {
          body: { code, personId: login.personId },
        }),
        "/login/totp",
      ).data;
      if (totp.status !== "success")
        throw new Error(`2FA status ${totp.status}`);
    } else if (login.status !== "success") {
      throw new Error(login.message || `status ${login.status}`);
    }
    const user = parse(
      whoamiSchema,
      await fresh.request("GET", "/whoami", {
        query: { only_allow_authenticated: true },
      }),
      "/whoami",
    ).data;
    if (user.id <= 0)
      throw new Error("ChurchTools still sees the anonymous user");
    fresh.setCsrfToken(
      parse(csrfSchema, await fresh.request("GET", "/csrftoken"), "/csrftoken")
        .data,
    );
    return { personId: user.id, name: `${user.firstName} ${user.lastName}` };
  }

  /** A 401 logs out only the session it happened on, never a newer one. */
  function expire(on: CtClient): void {
    if (client === on) state = { state: "logged_out" };
  }

  async function instance(on: CtClient) {
    try {
      const answer = await on.request("GET", "/info");
      const { version, build, siteName } = parse(infoSchema, answer, "/info");
      return { version, build, siteName };
    } catch (error) {
      if (error instanceof SessionExpiredError) expire(on);
      return { error: errorText(error) };
    }
  }

  return {
    state: (): SessionState => state,

    /** A new login always starts a fresh cookie jar; a failure leaves the session logged out. */
    async login(code: string): Promise<SessionState> {
      if (!config.ok) throw new Error(config.error);
      const { url, password } = config.config;
      const mine = newClient(url);
      client = mine;
      state = { state: "logged_out" };
      try {
        const user = await signIn(mine, config.config, code);
        // Only the newest ct_login sets the state; an older one just reports it.
        if (client === mine) state = { state: "ready", ...user };
        return state;
      } catch (error) {
        // errorText never returns a raw body: it may echo the password in any escaping.
        const message = errorText(error);
        throw new Error(`Login failed: ${redact(message, [password, code])}`);
      }
    },

    /** Never fails: an unreachable instance shows as `instance.error`. */
    async status() {
      if (!config.ok) {
        return { configValid: false, configError: config.error, ...state };
      }
      client ??= newClient(config.config.url);
      const info = await instance(client);
      return { configValid: true, ...state, instance: info };
    },

    /** Runs a call on a ready session; a 401 logs out and asks for the 2FA code. */
    async use<T>(action: (client: CtClient) => Promise<T>): Promise<T> {
      const current = client;
      if (state.state !== "ready" || !current) throw new Error(loginRequired);
      try {
        return await action(current);
      } catch (error) {
        if (!(error instanceof SessionExpiredError)) throw error;
        expire(current);
        throw new Error(loginRequired);
      }
    },
  };
}

export type Session = ReturnType<typeof createSession>;
