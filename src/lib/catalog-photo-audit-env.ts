export const RUNTIME_KEYS = [
  "DATABASE_URL",
  "APP_RUNTIME_PASSWORD",
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET",
] as const;

export type RuntimeKey = (typeof RUNTIME_KEYS)[number];

export type RuntimeConfig = {
  databaseUrl: string;
  databaseHost: string;
  appRuntimePassword: string;
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
};

export type RuntimeValidation =
  | { ok: true; config: RuntimeConfig }
  | { ok: false; message: string };

/** Hostname only. Never echoes the URL, userinfo, or password. */
export function databaseHost(databaseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("DATABASE_URL is not a valid database URL");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("DATABASE_URL is not a valid database URL");
  }
  if (!parsed.hostname) {
    throw new Error("DATABASE_URL is not a valid database URL");
  }
  return parsed.hostname;
}

/**
 * Six runtime keys. DIRECT_URL is intentionally absent: migrations use it,
 * this audit must not. NEXT_PHASE does not waive APP_RUNTIME_PASSWORD.
 */
export function validateRuntimeEnv(env: Record<string, string | undefined>): RuntimeValidation {
  const missing = RUNTIME_KEYS.filter((key) => !env[key]?.trim());
  if (missing.length > 0) {
    return { ok: false, message: `Missing environment: ${missing.join(", ")}\n` };
  }
  let host: string;
  try {
    host = databaseHost(env.DATABASE_URL ?? "");
  } catch (err) {
    const message = err instanceof Error ? err.message : "DATABASE_URL is not a valid database URL";
    return { ok: false, message: `${message}\n` };
  }
  return {
    ok: true,
    config: {
      databaseUrl: env.DATABASE_URL ?? "",
      databaseHost: host,
      appRuntimePassword: env.APP_RUNTIME_PASSWORD ?? "",
      accountId: env.R2_ACCOUNT_ID ?? "",
      accessKeyId: env.R2_ACCESS_KEY_ID ?? "",
      secretAccessKey: env.R2_SECRET_ACCESS_KEY ?? "",
      bucket: env.R2_BUCKET ?? "",
    },
  };
}

/** Strip connection strings and known secret values from a diagnostic. */
export function redactSecrets(text: string, secrets: Array<string | undefined>): string {
  let out = text.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[redacted-url]");
  const values = secrets.filter((secret): secret is string => !!secret).sort((a, b) => b.length - a.length);
  for (const secret of values) {
    out = out.split(secret).join("[redacted]");
  }
  return out;
}

export function secretsInEnv(env: Record<string, string | undefined>): string[] {
  return [env.DATABASE_URL, env.APP_RUNTIME_PASSWORD, env.R2_ACCESS_KEY_ID, env.R2_SECRET_ACCESS_KEY, env.DIRECT_URL]
    .filter((value): value is string => !!value);
}
