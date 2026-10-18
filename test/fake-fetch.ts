export interface Call {
  path: string;
  method: string;
  headers: Headers;
  body: unknown;
}

/** A fake fetch that answers with the queued responses in order (an Error rejects); `path` drops the origin. */
export function fakeFetch(...responses: (Response | Error)[]) {
  const calls: Call[] = [];
  const fetch: typeof globalThis.fetch = (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : input);
    calls.push({
      path: url.pathname + url.search,
      method: init.method ?? "GET",
      headers: new Headers(init.headers),
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const response = responses.shift();
    if (!response) throw new Error("no response queued");
    if (response instanceof Error) return Promise.reject(response);
    return Promise.resolve(response);
  };
  return { fetch, calls };
}

export function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(body), { ...init, headers });
}

export const env = {
  CT_URL: "https://example.org/churchtools",
  CT_USERNAME: "admin@example.org",
  CT_PASSWORD: "pa55-S3cret",
};
export const code = "918273";
export const cookieValue = "c00kie-S3cret";
export const csrfToken = "csrf-T0ken-S3cret";
export const secrets = [env.CT_PASSWORD, code, cookieValue, csrfToken];

/** The answers of a full login: /login (with `status`), /login/totp if needed, /whoami, /csrftoken. */
export function loginAnswers(
  status: "success" | "totp" = "totp",
  person = { id: 7, firstName: "Anna", lastName: "Admin" },
): Response[] {
  const login = json(
    { data: { status, message: "", personId: person.id } },
    { headers: { "set-cookie": `ChurchTools_ct=${cookieValue}; Path=/` } },
  );
  const totp = json({ data: { status: "success" } });
  return [
    login,
    ...(status === "totp" ? [totp] : []),
    json({ data: person }),
    json({ data: csrfToken }),
  ];
}
