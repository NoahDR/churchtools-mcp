import { expect, test } from "vitest";
import { totp } from "./live/totp.js";

/** RFC 6238 appendix B: the SHA-1 secret "12345678901234567890" in base32. */
const rfcSecret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

test.each([
  [59, "287082"],
  [1111111109, "081804"],
  [1111111111, "050471"],
  [1234567890, "005924"],
  [2000000000, "279037"],
])(
  "the code at %i s is the RFC 6238 SHA-1 value's last 6 digits",
  (seconds, code) => {
    expect(totp(rfcSecret, seconds * 1000)).toBe(code);
  },
);
