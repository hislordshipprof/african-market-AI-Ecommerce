export function runtimeDatabaseUrl(env: Record<string, string | undefined>): string {
  const baseUrl = env.DATABASE_URL;
  if (!baseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  const password = env.APP_RUNTIME_PASSWORD;
  if (!password) {
    if (env.VERCEL_ENV === "production" || env.VERCEL_ENV === "preview") {
      throw new Error(
        "APP_RUNTIME_PASSWORD is required in production/preview. " +
          "The app must connect as app_runtime to enforce RLS.",
      );
    }
    console.warn(
      "APP_RUNTIME_PASSWORD not set — falling back to DATABASE_URL (dev only).",
    );
    return baseUrl;
  }

  const url = new URL(baseUrl);
  url.username = "app_runtime";
  url.password = password;
  return url.toString();
}

export function resolveDirectUrl(): string {
  const unpooled = process.env.DATABASE_URL_UNPOOLED;
  if (unpooled) return unpooled;

  const direct = process.env.DIRECT_URL;
  if (direct) return direct;

  throw new Error(
    "Neither DATABASE_URL_UNPOOLED nor DIRECT_URL is set (or both are empty). " +
      "Migrations and seeds require a direct (non-pooled) connection string.",
  );
}
