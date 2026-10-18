import { z } from "zod";

const required = z
  .string("is missing")
  .refine((value) => value.trim() !== "", "is missing");

function hasNoCredentials(url: string): boolean {
  const parsed = URL.parse(url);
  return !parsed?.username && !parsed?.password;
}

const envSchema = z.object({
  CT_URL: required
    .pipe(z.url({ protocol: /^https$/, error: "must be an https URL" }))
    .refine((url) => !/[?#]/.test(url), "must not contain a query or fragment")
    .refine(hasNoCredentials, "must not contain a username or password")
    .transform((url) => url.replace(/\/+$/, "")),
  CT_USERNAME: required,
  CT_PASSWORD: required,
});

export interface Config {
  url: string;
  username: string;
  password: string;
}

export type ConfigResult =
  { ok: true; config: Config } | { ok: false; error: string };

/** Error texts name the variable and never echo its value. */
export function readConfig(env: NodeJS.ProcessEnv): ConfigResult {
  // A .env saved with a byte order mark hands it on as part of its first key.
  const keys = Object.entries(env).map(([key, value]) => [
    key.replace(/^\uFEFF/, ""),
    value,
  ]);
  const parsed = envSchema.safeParse(Object.fromEntries(keys));
  if (!parsed.success) {
    const problems = parsed.error.issues.map(
      (issue) => `${String(issue.path[0])} ${issue.message}`,
    );
    return { ok: false, error: `Configuration: ${problems.join("; ")}` };
  }
  const { CT_URL, CT_USERNAME, CT_PASSWORD } = parsed.data;
  return {
    ok: true,
    config: { url: CT_URL, username: CT_USERNAME, password: CT_PASSWORD },
  };
}
