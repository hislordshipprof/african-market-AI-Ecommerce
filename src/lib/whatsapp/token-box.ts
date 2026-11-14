import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** WHATSAPP_TOKEN_KEY is unset or not 32 bytes of base64. Thrown at call time, never at import. */
export class TokenKeyMissingError extends Error {
  constructor() {
    super("WHATSAPP_TOKEN_KEY is not set");
    this.name = "TokenKeyMissingError";
  }
}

/** The row a token belongs to. Bound as associated data, so a ciphertext copied to another row fails. */
export interface TokenOwner {
  storeId: string;
  phoneNumberId: string;
}

const VERSION = "v1";

function readKey(env: Record<string, string | undefined>): Buffer {
  const raw = env.WHATSAPP_TOKEN_KEY?.trim();
  const key = raw ? Buffer.from(raw, "base64") : Buffer.alloc(0);
  if (key.length !== 32) throw new TokenKeyMissingError();
  return key;
}

/** True when a token can be sealed: checked before Meta is called, so a linked number never lacks its token. */
export function hasTokenKey(env: Record<string, string | undefined> = process.env): boolean {
  try {
    readKey(env);
    return true;
  } catch {
    return false;
  }
}

function aad(owner: TokenOwner): Buffer {
  return Buffer.from(`${owner.storeId}:${owner.phoneNumberId}`);
}

/** AES-256-GCM: `v1:<iv>:<tag>:<ciphertext>`, each part base64. */
export function sealBusinessToken(
  token: string,
  owner: TokenOwner,
  env: Record<string, string | undefined> = process.env,
): string {
  const key = readKey(env);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad(owner));
  const body = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return [VERSION, iv.toString("base64"), cipher.getAuthTag().toString("base64"), body.toString("base64")].join(":");
}

export function openBusinessToken(
  sealed: string,
  owner: TokenOwner,
  env: Record<string, string | undefined> = process.env,
): string {
  const key = readKey(env);
  const [version, iv, tag, body] = sealed.split(":");
  if (version !== VERSION || !iv || !tag || !body) throw new Error("Unreadable business token");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"), { authTagLength: 16 });
  decipher.setAAD(aad(owner));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(body, "base64")), decipher.final()]).toString("utf8");
}
