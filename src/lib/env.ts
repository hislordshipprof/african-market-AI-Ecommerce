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
