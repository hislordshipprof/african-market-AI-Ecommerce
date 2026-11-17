import { isLoopback } from "./catalog-prune";

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

/**
 * The test admin's known password and TOTP secret may only land in a local or CI database (#714).
 * observedHost is what Postgres reports (inet_server_addr); urlHost is the connection string's host.
 */
export function assertTestAdminSeedTarget(
  env: Record<string, string | undefined>,
  target: { observedHost: string; urlHost: string | null },
) {
  if (env.SEED_TEST_ADMIN !== "1") return;
  if (env.VERCEL_ENV === "preview") {
    throw new Error("SEED_TEST_ADMIN refused: seeding test admin on a preview deployment is not allowed");
  }
  if (isLoopback(target.observedHost)) return;
  // GitHub Actions reaches its Postgres service container through localhost; Postgres sees the Docker bridge address.
  const githubService =
    env.GITHUB_ACTIONS === "true" && target.urlHost !== null && isLoopback(target.urlHost) && isDockerBridge(target.observedHost);
  if (githubService) return;
  throw new Error(
    `SEED_TEST_ADMIN refused: database host ${target.observedHost} is not local or a known CI host`,
  );
}

function isDockerBridge(host: string): boolean {
  const octets = host.replace(/\/\d{1,3}$/, "").split(".").map(Number);
  return octets.length === 4 && octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31;
}
