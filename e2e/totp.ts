import { createHmac } from "crypto";

export function generateTOTP(secret: string, period = 30, digits = 6): string {
  const counter = Math.floor(Date.now() / 1000 / period);
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));

  const hmac = createHmac("sha1", Buffer.from(secret, "utf-8"));
  hmac.update(buffer);
  const hash = hmac.digest();

  const offset = hash[hash.length - 1] & 0x0f;
  const code =
    (((hash[offset] & 0x7f) << 24) |
      ((hash[offset + 1] & 0xff) << 16) |
      ((hash[offset + 2] & 0xff) << 8) |
      (hash[offset + 3] & 0xff)) %
    10 ** digits;

  return code.toString().padStart(digits, "0");
}
