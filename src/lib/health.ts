type QueryRawFn = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<unknown[]>;

const REQUIRED_ENV_VARS = [
  "BETTER_AUTH_SECRET",
  "APP_RUNTIME_PASSWORD",
  "RESEND_API_KEY",
  "DATABASE_URL",
  "DATABASE_URL_UNPOOLED",
] as const;

export function checkEnv(
  env: Record<string, string | undefined>,
): Record<string, boolean> {
  const result: Record<string, boolean> = {};
  for (const name of REQUIRED_ENV_VARS) {
    if (name === "DATABASE_URL_UNPOOLED") {
      result[name] = !!(env.DATABASE_URL_UNPOOLED || env.DIRECT_URL);
    } else {
      result[name] = !!env[name];
    }
  }
  return result;
}

export async function checkDatabase(
  queryRaw: QueryRawFn,
): Promise<{ reachable: boolean; user: string | null }> {
  try {
    const rows = (await queryRaw`SELECT current_user`) as {
      current_user: string;
    }[];
    return { reachable: true, user: rows[0]?.current_user ?? null };
  } catch {
    return { reachable: false, user: null };
  }
}

export async function checkMigrations(
  queryRaw: QueryRawFn,
): Promise<{ upToDate: boolean }> {
  try {
    const rows = (await queryRaw`SELECT COUNT(*)::int AS count FROM "_prisma_migrations" WHERE "finished_at" IS NULL OR "rolled_back_at" IS NOT NULL`) as {
      count: number | bigint;
    }[];
    const count = Number(rows[0]?.count ?? 0);
    return { upToDate: count === 0 };
  } catch {
    return { upToDate: false };
  }
}

export interface HealthResult {
  version: string;
  database: { reachable: boolean; user: string | null };
  migrations: { upToDate: boolean };
  env: Record<string, boolean>;
}

export async function runHealthChecks(deps: {
  env: Record<string, string | undefined>;
  queryRaw: QueryRawFn;
}): Promise<{ status: number; body: HealthResult }> {
  const [database, migrations] = await Promise.all([
    checkDatabase(deps.queryRaw),
    checkMigrations(deps.queryRaw),
  ]);

  const envResult = checkEnv(deps.env);
  const version = deps.env.VERCEL_GIT_COMMIT_SHA || "unknown";

  const healthy =
    database.reachable &&
    migrations.upToDate &&
    Object.values(envResult).every(Boolean);

  return {
    status: healthy ? 200 : 503,
    body: { version, database, migrations, env: envResult },
  };
}
