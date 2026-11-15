import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { openBusinessToken, sealBusinessToken, TokenKeyMissingError } from "./token-box";

const KEY = randomBytes(32).toString("base64");
const env = { WHATSAPP_TOKEN_KEY: KEY };
const A = { storeId: "store-a", phoneNumberId: "1111111111" };
const B = { storeId: "store-b", phoneNumberId: "1111111111" };
const TOKEN = "EAAG-business-token-for-store-a";

describe("business token encryption", () => {
  it("round-trips, never contains the token, and differs on every seal", () => {
    const first = sealBusinessToken(TOKEN, A, env);
    const second = sealBusinessToken(TOKEN, A, env);
    expect(first).not.toContain(TOKEN);
    expect(first).not.toContain(Buffer.from(TOKEN).toString("base64"));
    expect(first).not.toBe(second);
    expect(openBusinessToken(first, A, env)).toBe(TOKEN);
  });

  it("refuses a ciphertext moved to another store's row, a tampered one, or another key", () => {
    const sealed = sealBusinessToken(TOKEN, A, env);
    expect(() => openBusinessToken(sealed, B, env)).toThrow();
    const parts = sealed.split(":");
    const body = Buffer.from(parts[3], "base64");
    body[0] ^= 1;
    const tampered = [...parts.slice(0, 3), body.toString("base64")].join(":");
    expect(() => openBusinessToken(tampered, A, env)).toThrow();
    expect(() => openBusinessToken(sealed, A, { WHATSAPP_TOKEN_KEY: randomBytes(32).toString("base64") })).toThrow();
  });

  it("throws at call time when the key is unset or not 32 bytes", () => {
    expect(() => sealBusinessToken(TOKEN, A, {})).toThrow(TokenKeyMissingError);
    expect(() => sealBusinessToken(TOKEN, A, { WHATSAPP_TOKEN_KEY: randomBytes(16).toString("base64") })).toThrow(TokenKeyMissingError);
    expect(() => openBusinessToken("v1:a:b:c", A, {})).toThrow(TokenKeyMissingError);
  });
});
