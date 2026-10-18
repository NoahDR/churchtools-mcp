import { z } from "zod";

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

type QueryValue = string | number | boolean | (string | number)[] | undefined;
export type Query = Record<string, QueryValue>;

export interface RequestOptions {
  query?: Query;
  body?: unknown;
}

const fieldErrorSchema = z.object({
  fieldId: z.string().nullish(),
  message: z.string().nullish(),
  messageKey: z.string().nullish(),
});

export type FieldError = z.infer<typeof fieldErrorSchema>;

export interface CtErrorDetails {
  /** The parsed `translatedMessage` or `message`; absent when the text is the raw body. */
  serverMessage?: string;
  messageKey?: string;
  errors?: FieldError[];
  args?: unknown;
}

/** An error answer of ChurchTools; its text comes from the server, never from the request. */
export class CtError extends Error {
  readonly serverMessage?: string;
  readonly messageKey?: string;
  readonly errors?: FieldError[];
  readonly args?: unknown;

  constructor(
    readonly status: number,
    message: string,
    details: CtErrorDetails = {},
  ) {
    super(message);
    this.name = "CtError";
    this.serverMessage = details.serverMessage;
    this.messageKey = details.messageKey;
    this.errors = details.errors;
    this.args = details.args;
  }
}

export class SessionExpiredError extends CtError {
  constructor(message: string, details: CtErrorDetails = {}) {
    super(401, message, details);
    this.name = "SessionExpiredError";
  }
}

/** A CtError's parsed message or its status, never a raw body: an error page may echo the cookie. */
export function errorText(error: unknown): string {
  if (error instanceof CtError)
    return error.serverMessage ?? `HTTP ${error.status}`;
  return error instanceof Error ? error.message : String(error);
}

/** The answer of `path` as `schema` reads it; any other shape is an error that does not echo the answer. */
export function parse<T>(
  schema: z.ZodType<T>,
  answer: unknown,
  path: string,
): T {
  const parsed = schema.safeParse(answer);
  if (!parsed.success) throw new Error(`Unexpected answer from ${path}`);
  return parsed.data;
}

/** Lenient: a malformed part is dropped, the rest of the body survives. */
const errorBodySchema = z.object({
  message: z.string().optional().catch(undefined),
  translatedMessage: z.string().optional().catch(undefined),
  messageKey: z.string().optional().catch(undefined),
  errors: z
    .array(z.unknown())
    .optional()
    .catch(undefined)
    .transform((entries) =>
      entries?.flatMap((entry) => {
        const parsed = fieldErrorSchema.safeParse(entry);
        return parsed.success ? [parsed.data] : [];
      }),
    ),
  args: z.unknown().optional(),
});

const listSchema = z.object({
  data: z.array(z.unknown()),
  meta: z
    .object({
      pagination: z
        .object({ current: z.number(), lastPage: z.number() })
        .optional(),
    })
    .optional(),
});

const noCsrfPaths = new Set(["/login", "/login/totp"]);
const maxRetrySeconds = 30;
const pageLimit = 100;

/** JSON when the text parses, else the text itself; an empty body is undefined. */
function parseBody(text: string): unknown {
  if (text === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function toError(status: number, text: string): CtError {
  const parsed = errorBodySchema.safeParse(parseBody(text));
  const body: Partial<z.infer<typeof errorBodySchema>> = parsed.success
    ? parsed.data
    : {};
  const serverMessage = body.translatedMessage || body.message || undefined;
  const message =
    serverMessage || text || `ChurchTools answered HTTP ${status}`;
  const details = {
    serverMessage,
    messageKey: body.messageKey,
    errors: body.errors,
    args: body.args,
  };
  if (status === 401) return new SessionExpiredError(message, details);
  return new CtError(status, message, details);
}

/** RFC 6265: Max-Age wins over Expires; an unreadable date keeps the cookie. */
function isExpired(setCookie: string): boolean {
  const maxAge = /;\s*max-age\s*=\s*(-?\d+)/i.exec(setCookie);
  if (maxAge) return Number(maxAge[1]) <= 0;
  const expires = /;\s*expires\s*=\s*([^;]*)/i.exec(setCookie);
  return expires ? Date.parse(expires[1] ?? "") <= Date.now() : false;
}

function toSearch(query: Query): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    for (const item of [value].flat()) {
      if (item !== undefined) params.append(key, String(item));
    }
  }
  const search = params.toString();
  return search ? `?${search}` : "";
}

/** Seconds to wait before the one retry; longer than 30 s is an error. */
function retrySeconds(response: Response): number {
  const header = response.headers.get("retry-after")?.trim() ?? "";
  const seconds = /^\d+$/.test(header) ? Number(header) : maxRetrySeconds;
  if (seconds > maxRetrySeconds) {
    const message = `Rate limited; retry after ${seconds} s`;
    throw new CtError(429, message, { serverMessage: message });
  }
  return seconds;
}

/** The body as text; a body above `maxBytes`, declared or read, is an error and is not read further. */
async function readCapped(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const tooLarge = () =>
    new Error(`The answer is larger than ${maxBytes} bytes`);
  if (Number(response.headers.get("content-length")) > maxBytes) {
    await response.body?.cancel();
    throw tooLarge();
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.byteLength;
    if (size > maxBytes) throw tooLarge();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** fetch says only "fetch failed"; the host and the network code (ENOTFOUND, ECONNREFUSED…) say what went wrong. */
function unreachable(baseUrl: string, error: unknown): Error {
  const cause = error instanceof Error ? error.cause : undefined;
  const code =
    cause instanceof Error && "code" in cause ? String(cause.code) : undefined;
  const reason = code ?? (error instanceof Error ? error.message : "unknown");
  return new Error(`cannot reach ${new URL(baseUrl).host}: ${reason}`, {
    cause: error,
  });
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createCtClient({
  baseUrl,
  fetch,
  timeoutMs = 60_000,
}: {
  baseUrl: string;
  fetch: typeof globalThis.fetch;
  /** A request, its body included, that takes longer fails instead of blocking the tool call. */
  timeoutMs?: number;
}) {
  const cookies = new Map<string, string>();
  let csrfToken: string | undefined;

  function storeCookies(response: Response): void {
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(";")[0] ?? "";
      const separator = pair.indexOf("=");
      if (separator <= 0) continue;
      const name = pair.slice(0, separator).trim();
      if (isExpired(cookie)) cookies.delete(name);
      else cookies.set(name, pair.slice(separator + 1));
    }
  }

  function headersFor(method: Method, path: string, hasBody: boolean) {
    const headers: Record<string, string> = { accept: "application/json" };
    if (hasBody) headers["content-type"] = "application/json";
    if (cookies.size > 0) {
      headers.cookie = [...cookies].map(([n, v]) => `${n}=${v}`).join("; ");
    }
    if (csrfToken && method !== "GET" && !noCsrfPaths.has(path)) {
      headers["csrf-token"] = csrfToken;
    }
    return headers;
  }

  async function send(
    method: Method,
    path: string,
    { query = {}, body }: RequestOptions,
    root = `${baseUrl}/api`,
  ): Promise<Response> {
    const response = await fetch(`${root}${path}${toSearch(query)}`, {
      method,
      headers: headersFor(method, path, body !== undefined),
      body: body === undefined ? undefined : JSON.stringify(body),
      // A followed 307/308 would resend the login body, password included, to wherever it points.
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    }).catch((error: unknown) => {
      if (error instanceof DOMException && error.name === "TimeoutError") {
        throw new Error(
          `${new URL(baseUrl).host} did not answer within ${timeoutMs / 1000} s`,
        );
      }
      throw unreachable(baseUrl, error);
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new Error(
        `${new URL(baseUrl).host} answered with a redirect (HTTP ${response.status}): set CT_URL to the address it redirects to`,
      );
    }
    storeCookies(response);
    return response;
  }

  async function request(
    method: Method,
    path: string,
    options: RequestOptions = {},
  ): Promise<unknown> {
    let response = await send(method, path, options);
    if (response.status === 429) {
      await response.body?.cancel();
      await wait(retrySeconds(response) * 1000);
      response = await send(method, path, options);
    }
    const text = await response.text();
    if (!response.ok) throw toError(response.status, text);
    return parseBody(text);
  }

  /** GETs a file outside /api, such as the OpenAPI spec, with the session cookie. */
  async function getFile(path: string, maxBytes: number): Promise<unknown> {
    const response = await send("GET", path, {}, baseUrl);
    const text = await readCapped(response, maxBytes);
    if (!response.ok) throw toError(response.status, text);
    return parseBody(text);
  }

  /** Reads every page of a list endpoint, up to `max` records. */
  async function getAll(
    path: string,
    query: Query = {},
    max = 500,
  ): Promise<unknown[]> {
    const items: unknown[] = [];
    for (let page = 1; items.length < max; page++) {
      const answer = await request("GET", path, {
        query: { ...query, page, limit: pageLimit },
      });
      const { data, meta } = listSchema.parse(answer);
      items.push(...data);
      const pagination = meta?.pagination;
      if (!pagination || data.length === 0) break;
      if (pagination.current >= pagination.lastPage) break;
    }
    return items.slice(0, max);
  }

  return {
    baseUrl,
    request,
    getAll,
    getFile,
    setCsrfToken(token: string): void {
      csrfToken = token;
    },
  };
}

export type CtClient = ReturnType<typeof createCtClient>;
