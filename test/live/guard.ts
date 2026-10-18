import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";

/** Hostname without trailing dots, lowercase, plus the port ("" for the default); null when unparsable. */
function hostOf(url: string): string | null {
  const parsed = URL.parse(url.trim());
  return parsed && `${parsed.hostname.replace(/\.+$/, "")}:${parsed.port}`;
}

/** Throws when the live URL's host is the host of the CT_URL of the shell or of `envFile`; the file is parsed, never loaded. */
export function refuseProduction(
  liveUrl: string | undefined,
  shellUrl: string | undefined,
  envFile = ".env",
): void {
  const live = hostOf(liveUrl ?? "");
  if (!live) throw new Error("CT_LIVE_URL is not a URL");
  const fileUrl = existsSync(envFile)
    ? parseEnv(readFileSync(envFile, "utf8").replace(/^﻿/, "")).CT_URL
    : undefined;
  if ([shellUrl, fileUrl].some((url) => url && hostOf(url) === live)) {
    throw new Error(
      "CT_LIVE_URL equals CT_URL: live tests write data and run only against a trial instance",
    );
  }
}
