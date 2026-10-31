export function assertNotProduction(env: {
  VERCEL_ENV?: string;
  NODE_ENV?: string;
}) {
  const isProduction =
    env.VERCEL_ENV === "production" || env.NODE_ENV === "production";
  if (isProduction) {
    throw new Error(
      "SEED_TEST_ADMIN refused: seeding test admin in production is not allowed",
    );
  }
}
