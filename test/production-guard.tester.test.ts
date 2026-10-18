import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { refuseProduction } from "./live/guard.js";

const production = "https://production.invalid";
const trial = "https://trial.invalid";
const refusal = "CT_LIVE_URL equals CT_URL";

function envFile(content: string | Buffer): string {
  const file = join(mkdtempSync(join(tmpdir(), "live-guard-")), ".env");
  writeFileSync(file, content);
  return file;
}

const missing = join(tmpdir(), "live-guard-missing", ".env");

describe("the live guard reads CT_URL from .env in every shape", () => {
  test.each([
    ["unquoted", `CT_URL=${production}\n`],
    ["double-quoted", `CT_URL="${production}"\n`],
    ["single-quoted", `CT_URL='${production}'\n`],
    ["with a trailing slash", `CT_URL="${production}/"\n`],
    ["with many trailing slashes", `CT_URL="${production}///"\n`],
    ["with an uppercase host", `CT_URL="HTTPS://PRODUCTION.INVALID"\n`],
    ["with spaces inside the quotes", `CT_URL="  ${production}  "\n`],
    [
      "after other keys",
      `CT_USERNAME="u"\nCT_PASSWORD="p"\nCT_URL="${production}"\n`,
    ],
    ["with CRLF line ends", `CT_URL="${production}"\r\nCT_USERNAME="u"\r\n`],
    [
      "as the last line without a newline",
      `CT_USERNAME="u"\nCT_URL="${production}"`,
    ],
    ["after a comment line", `# production\nCT_URL="${production}"\n`],
    ["with a trailing comment", `CT_URL="${production}" # production\n`],
  ])("refuses a .env CT_URL %s", (_shape, content) => {
    expect(() =>
      refuseProduction(production, undefined, envFile(content)),
    ).toThrow(refusal);
  });

  test("refuses a .env CT_URL behind a UTF-8 byte order mark", () => {
    const file = envFile(Buffer.from(`﻿CT_URL="${production}"\n`, "utf8"));

    expect(() => refuseProduction(production, undefined, file)).toThrow(
      refusal,
    );
  });
});

describe("the live guard normalises CT_LIVE_URL", () => {
  test.each([
    ["a trailing slash", `${production}/`],
    ["an uppercase host", "https://PRODUCTION.invalid"],
    ["surrounding spaces", `  ${production}  `],
  ])("refuses the production URL with %s", (_shape, liveUrl) => {
    expect(() => refuseProduction(liveUrl, production, missing)).toThrow(
      refusal,
    );
  });

  test("refuses the production host spelt with its default port 443", () => {
    expect(() =>
      refuseProduction(`${production}:443`, production, missing),
    ).toThrow(refusal);
  });
});

describe("the live guard lets a trial instance through", () => {
  test("when .env is missing and the shell has no CT_URL", () => {
    expect(() => refuseProduction(trial, undefined, missing)).not.toThrow();
  });

  test("when .env has no CT_URL", () => {
    const file = envFile(`CT_USERNAME="u"\n`);

    expect(() => refuseProduction(trial, undefined, file)).not.toThrow();
  });

  test("when .env is empty and the shell CT_URL is empty", () => {
    expect(() => refuseProduction(trial, "", envFile(""))).not.toThrow();
  });

  test("when the trial host only extends the production host", () => {
    expect(() =>
      refuseProduction(
        "https://production.invalid.trial.invalid",
        production,
        missing,
      ),
    ).not.toThrow();
  });
});

test("the live guard refuses the shell CT_URL when .env names another instance", () => {
  const file = envFile(`CT_URL="${trial}"\n`);

  expect(() => refuseProduction(production, production, file)).toThrow(refusal);
});

test("the live guard message names neither URL", () => {
  const secretHost = "https://secret-church.invalid";
  let message = "";
  try {
    refuseProduction(secretHost, secretHost, missing);
  } catch (error) {
    message = String(error);
  }

  expect(message).toContain(refusal);
  expect(message).not.toContain("secret-church");
});

test("the live guard refuses the production host with a trailing dot and an explicit port", () => {
  expect(() =>
    refuseProduction(
      "https://production.invalid.:8443",
      "https://production.invalid:8443",
      missing,
    ),
  ).toThrow(refusal);
});
