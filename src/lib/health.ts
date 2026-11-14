import { inngestDevOn } from "./inngest/event-key";

export type QueryRawFn = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<unknown[]>;

export const HEALTH_QUERY_TIMEOUT_MS = 5000;

// Client-side backstop: the server-side timeout can't fire if the connection itself hangs.
function withDeadline<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("Health query timed out")),
      HEALTH_QUERY_TIMEOUT_MS,
    );
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

const CORE_ENV_VARS = ["DATABASE_URL", "DATABASE_URL_UNPOOLED"] as const;
const DEPLOY_ENV_VARS = [
  "BETTER_AUTH_SECRET",
  "APP_RUNTIME_PASSWORD",
  "RESEND_API_KEY",
] as const;
const INNGEST_ENV_VARS = ["INNGEST_EVENT_KEY", "INNGEST_SIGNING_KEY"] as const;

export function requiredEnvVars(
  env: Record<string, string | undefined>,
): readonly string[] {
  const vercelEnv = env.VERCEL_ENV;
  if (vercelEnv === "production") {
    return [...CORE_ENV_VARS, ...DEPLOY_ENV_VARS, ...INNGEST_ENV_VARS];
  }
  if (vercelEnv === "preview") {
    return [...CORE_ENV_VARS, ...DEPLOY_ENV_VARS];
  }
  return [...CORE_ENV_VARS];
}

/** Previews report the Inngest keys without failing: the owner sets them in #269. */
function reportedEnvVars(env: Record<string, string | undefined>): readonly string[] {
  return env.VERCEL_ENV === "preview" ? INNGEST_ENV_VARS : [];
}

let loggedInngestDev = false;

/** Vercel ignores INNGEST_DEV (client.ts), so it is a config mistake to log once, not an outage. */
function warnEnvFlags(env: Record<string, string | undefined>): void {
  if (env.VERCEL_ENV === "production" && inngestDevOn(env) && !loggedInngestDev) {
    loggedInngestDev = true;
    console.warn("Health check: INNGEST_DEV is set in production");
  }
}

export function checkEnv(
  env: Record<string, string | undefined>,
): Record<string, boolean> {
  const result: Record<string, boolean> = {};
  for (const name of [...requiredEnvVars(env), ...reportedEnvVars(env)]) {
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
    const rows = (await withDeadline(
      queryRaw`SELECT current_user`,
    )) as { current_user: string }[];
    return { reachable: true, user: rows[0]?.current_user ?? null };
  } catch (err) {
    console.error("Health check: database unreachable", err);
    return { reachable: false, user: null };
  }
}

function isMissingRelation(err: unknown): boolean {
  return err instanceof Error && /relation .* does not exist/i.test(err.message);
}

export async function checkMigrations(
  queryRaw: QueryRawFn,
): Promise<{ upToDate: boolean }> {
  try {
    // One shared 5 s budget for both queries. A missing table means migrations don't
    // apply (e.g. `prisma db push`), not that they're pending. to_regclass resolves via
    // search_path like the count query below and ignores table privileges.
    return await withDeadline(
      (async () => {
        const present = (await queryRaw`SELECT to_regclass('"_prisma_migrations"') IS NOT NULL AS present`) as {
          present?: boolean;
        }[];
        if (present[0]?.present === false) return { upToDate: true };

        const rows = (await queryRaw`SELECT COUNT(*)::int AS count FROM "_prisma_migrations" WHERE "finished_at" IS NULL OR "rolled_back_at" IS NOT NULL`) as {
          count: number | bigint;
        }[];
        return { upToDate: Number(rows[0]?.count ?? 0) === 0 };
      })(),
    );
  } catch (err) {
    if (isMissingRelation(err)) return { upToDate: true };
    console.error("Health check: migration status query failed", err);
    return { upToDate: false };
  }
}

export interface HealthResult {
  version: string;
  database: { reachable: boolean; user: string | null };
  migrations: { upToDate: boolean };
  env: Record<string, boolean>;
}

export interface MinimalHealthResult {
  status: "ok" | "degraded";
  version: string;
}

export function toMinimalResult(
  httpStatus: number,
  body: HealthResult,
): MinimalHealthResult {
  return {
    status: httpStatus === 200 ? "ok" : "degraded",
    version: body.version,
  };
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
  warnEnvFlags(deps.env);
  const version = deps.env.VERCEL_GIT_COMMIT_SHA || "unknown";

  const healthy =
    database.reachable &&
    migrations.upToDate &&
    requiredEnvVars(deps.env).every((name) => envResult[name]);

  return {
    status: healthy ? 200 : 503,
    body: { version, database, migrations, env: envResult },
  };
}
