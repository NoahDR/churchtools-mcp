import { createHmac } from "node:crypto";

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 base32 to bytes; case, spaces and "=" padding are ignored. */
function base32Decode(text: string): Buffer {
  const bits = [...text.toUpperCase().replace(/[\s=]/g, "")]
    .map((char) => {
      const value = alphabet.indexOf(char);
      if (value < 0) throw new Error("The TOTP secret is not base32");
      return value.toString(2).padStart(5, "0");
    })
    .join("");
  const bytes = bits.match(/.{8}/g) ?? [];
  return Buffer.from(bytes.map((byte) => parseInt(byte, 2)));
}

/** The RFC 6238 code (HMAC-SHA-1, 30 s steps, 6 digits) of a base32 secret at `now` (ms). */
export function totp(secret: string, now = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 30_000)));
  const hmac = createHmac("sha1", base32Decode(secret))
    .update(counter)
    .digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = hmac.readUInt32BE(offset) & 0x7fffffff;
  return String(code % 1_000_000).padStart(6, "0");
}
