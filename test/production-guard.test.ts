import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { refuseProduction } from "./live/guard.js";

const trial = "https://trial.invalid";
const production = "https://production.invalid";

function envFile(content: string): string {
  const file = join(mkdtempSync(join(tmpdir(), "live-guard-")), ".env");
  writeFileSync(file, content);
  return file;
}

test("the live guard refuses the CT_URL of the shell", () => {
  expect(() =>
    refuseProduction(`${production}/`, "HTTPS://Production.invalid", "none"),
  ).toThrow("CT_LIVE_URL equals CT_URL");
});

test("the live guard refuses the CT_URL of the .env file", () => {
  const file = envFile(`CT_URL="${production.toUpperCase()}/"\n`);

  expect(() => refuseProduction(production, undefined, file)).toThrow(
    "CT_LIVE_URL equals CT_URL",
  );
});

test("the live guard lets a trial instance through", () => {
  const file = envFile(`CT_URL="${production}"\n`);

  expect(() => refuseProduction(trial, production, file)).not.toThrow();
});

test("the live guard refuses a CT_LIVE_URL that is not a URL", () => {
  expect(() => refuseProduction("trial.invalid", undefined, "none")).toThrow(
    "CT_LIVE_URL is not a URL",
  );
});
