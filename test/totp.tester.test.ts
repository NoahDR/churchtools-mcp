import { createHmac } from "node:crypto";
import { describe, expect, test } from "vitest";
import { totp } from "./live/totp.js";

/** RFC 6238 appendix B: the SHA-1 secret "12345678901234567890" in base32. */
const rfcSecret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

/** RFC 4226 HOTP from raw key bytes: an oracle that does not decode base32. */
function hotp(key: Buffer, counter: number): string {
  const step = Buffer.alloc(8);
  step.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", key).update(step).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  return String((hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(
    6,
    "0",
  );
}

describe("the TOTP time step", () => {
  test.each([
    [0, "755224"],
    [29_999, "755224"],
    [30_000, "287082"],
    [59_999, "287082"],
    [60_000, "359152"],
  ])("at %i ms the code is the RFC 4226 value of its 30 s step", (ms, code) => {
    expect(totp(rfcSecret, ms)).toBe(code);
  });
});

describe("the TOTP secret spelling", () => {
  const expected = totp(rfcSecret, 59_000);

  test.each([
    ["lowercase", rfcSecret.toLowerCase()],
    ["mixed case", "GeZdGnBvGy3tQoJqGeZdGnBvGy3tQoJq"],
    ["groups of four with spaces", rfcSecret.replace(/(.{4})/g, "$1 ").trim()],
    ["surrounding spaces and a newline", `  ${rfcSecret}\n`],
    ["trailing padding", `${rfcSecret}====`],
  ])("reads the secret in %s", (_shape, secret) => {
    expect(totp(secret, 59_000)).toBe(expected);
  });

  test.each([
    ["MFRGG===", "abc"],
    ["MFRGG", "abc"],
    ["mfrgg===", "abc"],
    ["JBSWY3DPEHPK3PXP", "Hello!Þ­¾ï"],
  ])("decodes %s to the key bytes of %j", (secret, raw) => {
    const key = Buffer.from(raw, "latin1");

    expect(totp(secret, 90_000)).toBe(hotp(key, 3));
  });
});

describe("the TOTP secret check", () => {
  test.each([
    "GEZDGNBV1",
    "GEZDGNBV0",
    "GEZDGNBV8",
    "GEZDGNBV9",
    "GEZD-GNBV",
    "GEZDÄGNBV",
  ])("rejects %s as not base32", (secret) => {
    expect(() => totp(secret, 0)).toThrow("The TOTP secret is not base32");
  });

  test("the rejection names no part of the secret", () => {
    const secret = "SECRETSECRETS1X";
    let message = "";
    try {
      totp(secret, 0);
    } catch (error) {
      message = String(error);
    }

    expect(message).toContain("not base32");
    expect(message).not.toMatch(/SECRET|1X/);
  });
});
