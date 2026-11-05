/**
 * Gate for `/api/e2e/*`. Reads `env` only. A request header, query, or cookie
 * cannot open it. `optIn` is the route's own flag and must be exactly `"1"`.
 */
export function testOnlyRoutesAllowed(
  env: Record<string, string | undefined>,
  optIn: string | undefined,
): boolean {
  if (env.VERCEL) return false;
  if (env.VERCEL_ENV === "production") return false;
  if (env.NODE_ENV === "production" && env.VERCEL_ENV !== "preview" && env.CI !== "true") {
    return false;
  }
  return optIn === "1";
}
