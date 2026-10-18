import { expect, test } from "vitest";
import { readConfig } from "../src/config.js";

const password = "s3cret-Pa55word";
const validEnv = {
  CT_URL: "https://example.church.tools",
  CT_USERNAME: "admin",
  CT_PASSWORD: password,
};

function errorOf(env: NodeJS.ProcessEnv): string {
  const result = readConfig(env);
  if (result.ok) throw new Error("expected readConfig to fail");
  return result.error;
}

test("a complete environment yields the configuration", () => {
  expect(readConfig(validEnv)).toEqual({
    ok: true,
    config: {
      url: "https://example.church.tools",
      username: "admin",
      password,
    },
  });
});

test("a missing variable is named in the error", () => {
  expect(errorOf({ ...validEnv, CT_USERNAME: undefined })).toContain(
    "CT_USERNAME",
  );
});

test("an empty variable counts as missing", () => {
  expect(errorOf({ ...validEnv, CT_PASSWORD: "" })).toContain("CT_PASSWORD");
});

test("an http:// URL is rejected", () => {
  expect(
    errorOf({ ...validEnv, CT_URL: "http://example.church.tools" }),
  ).toContain("CT_URL");
});

test("a value that is not a URL is rejected", () => {
  expect(errorOf({ ...validEnv, CT_URL: "example.church.tools" })).toContain(
    "CT_URL",
  );
});

test("a missing CT_URL is reported as missing", () => {
  expect(errorOf({ ...validEnv, CT_URL: undefined })).toContain(
    "CT_URL is missing",
  );
});

test("a CT_URL with a query or fragment is rejected", () => {
  expect(
    errorOf({ ...validEnv, CT_URL: "https://example.church.tools/?x=" }),
  ).toContain("CT_URL");
});

test("a CT_URL with a subpath is kept", () => {
  const result = readConfig({
    ...validEnv,
    CT_URL: "https://example.org/churchtools/",
  });

  expect(result.ok && result.config.url).toBe(
    "https://example.org/churchtools",
  );
});

test("the trailing slash of CT_URL is removed", () => {
  const result = readConfig({
    ...validEnv,
    CT_URL: "https://example.church.tools/",
  });

  expect(result.ok && result.config.url).toBe("https://example.church.tools");
});

test.each([
  { CT_URL: "http://example.church.tools" },
  { CT_URL: password },
  { CT_USERNAME: "" },
  { CT_USERNAME: undefined, CT_URL: undefined },
])("no error text contains the password (%o)", (override) => {
  expect(errorOf({ ...validEnv, ...override })).not.toContain(password);
});

test("a CT_URL with user credentials is rejected", () => {
  expect(
    errorOf({ ...validEnv, CT_URL: "https://admin:pw@example.church.tools" }),
  ).toContain("CT_URL");
});

test("the error for a CT_URL with credentials does not contain them", () => {
  expect(
    errorOf({
      ...validEnv,
      CT_URL: `https://admin:${password}@example.church.tools`,
    }),
  ).not.toContain(password);
});

test("a whitespace-only CT_USERNAME counts as missing", () => {
  expect(errorOf({ ...validEnv, CT_USERNAME: "   " })).toContain(
    "CT_USERNAME is missing",
  );
});

test("spaces around CT_PASSWORD are kept", () => {
  const result = readConfig({ ...validEnv, CT_PASSWORD: ` ${password} ` });

  expect(result.ok && result.config.password).toBe(` ${password} `);
});

test.each([
  " https://example.church.tools \n",
  "HTTPS://example.church.tools",
  "https://example.church.tools//",
])("CT_URL %j prefixes to the API root", (url) => {
  const result = readConfig({ ...validEnv, CT_URL: url });
  if (!result.ok) throw new Error(result.error);

  expect(new URL(`${result.config.url}/api/whoami`).href).toBe(
    "https://example.church.tools/api/whoami",
  );
});

test("a .env saved with a byte order mark still yields CT_URL", () => {
  const { CT_URL, ...rest } = validEnv;
  expect(readConfig({ ...rest, "\uFEFFCT_URL": CT_URL })).toMatchObject({
    ok: true,
    config: { url: "https://example.church.tools" },
  });
});
