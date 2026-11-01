import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  checkEnv,
  checkDatabase,
  checkMigrations,
  runHealthChecks,
  requiredEnvVars,
  toMinimalResult,
  HEALTH_QUERY_TIMEOUT_MS,
} from "./health";
import type { HealthResult } from "./health";
import { runtimeDatabaseUrl } from "./env";
import { withStatementTimeout } from "./db";

describe("requiredEnvVars", () => {
  it("returns only core vars when VERCEL_ENV is absent", () => {
    expect(requiredEnvVars({})).toEqual(["DATABASE_URL", "DATABASE_URL_UNPOOLED"]);
  });

  it("returns all vars when VERCEL_ENV is production", () => {
    const vars = requiredEnvVars({ VERCEL_ENV: "production" });
    expect(vars).toContain("DATABASE_URL");
    expect(vars).toContain("BETTER_AUTH_SECRET");
    expect(vars).toContain("APP_RUNTIME_PASSWORD");
    expect(vars).toContain("RESEND_API_KEY");
    expect(vars).toHaveLength(5);
  });

  it("returns all vars when VERCEL_ENV is preview", () => {
    const vars = requiredEnvVars({ VERCEL_ENV: "preview" });
    expect(vars).toHaveLength(5);
  });

  it("returns only core vars when VERCEL_ENV is development", () => {
    expect(requiredEnvVars({ VERCEL_ENV: "development" })).toHaveLength(2);
  });
});

describe("checkEnv", () => {
  it("checks only core vars in CI/local (no VERCEL_ENV)", () => {
    const env = { DATABASE_URL: "postgres://x", DATABASE_URL_UNPOOLED: "postgres://y" };
    const result = checkEnv(env);
    expect(result).toEqual({ DATABASE_URL: true, DATABASE_URL_UNPOOLED: true });
    expect(result).not.toHaveProperty("BETTER_AUTH_SECRET");
    expect(result).not.toHaveProperty("APP_RUNTIME_PASSWORD");
    expect(result).not.toHaveProperty("RESEND_API_KEY");
  });

  it("checks all vars in production", () => {
    const env = {
      VERCEL_ENV: "production",
      BETTER_AUTH_SECRET: "s",
      APP_RUNTIME_PASSWORD: "p",
      RESEND_API_KEY: "r",
      DATABASE_URL: "postgres://x",
      DATABASE_URL_UNPOOLED: "postgres://y",
    };
    expect(checkEnv(env)).toEqual({
      BETTER_AUTH_SECRET: true,
      APP_RUNTIME_PASSWORD: true,
      RESEND_API_KEY: true,
      DATABASE_URL: true,
      DATABASE_URL_UNPOOLED: true,
    });
  });

  it("reports missing deploy vars in production", () => {
    const env = {
      VERCEL_ENV: "production",
      DATABASE_URL: "postgres://x",
      DATABASE_URL_UNPOOLED: "postgres://y",
    };
    const result = checkEnv(env);
    expect(result.BETTER_AUTH_SECRET).toBe(false);
    expect(result.APP_RUNTIME_PASSWORD).toBe(false);
    expect(result.RESEND_API_KEY).toBe(false);
    expect(result.DATABASE_URL).toBe(true);
  });

  it("accepts DIRECT_URL as satisfying DATABASE_URL_UNPOOLED", () => {
    const env = { DATABASE_URL: "postgres://x", DIRECT_URL: "postgres://z" };
    expect(checkEnv(env).DATABASE_URL_UNPOOLED).toBe(true);
  });

  it("never exposes env var values", () => {
    const env = {
      VERCEL_ENV: "production",
      BETTER_AUTH_SECRET: "super-secret",
      APP_RUNTIME_PASSWORD: "pw",
      RESEND_API_KEY: "key",
      DATABASE_URL: "postgres://user:pass@host/db",
      DATABASE_URL_UNPOOLED: "postgres://user:pass@host/db",
    };
    const json = JSON.stringify(checkEnv(env));
    expect(json).not.toContain("super-secret");
    expect(json).not.toContain("pw");
    expect(json).not.toContain("postgres://");
  });
});

describe("checkDatabase", () => {
  it("returns reachable true and the current user on success", async () => {
    const queryRaw = vi.fn().mockResolvedValue([{ current_user: "app_runtime" }]);
    const result = await checkDatabase(queryRaw);
    expect(result).toEqual({ reachable: true, user: "app_runtime" });
  });

  it("returns reachable false on query failure", async () => {
    const queryRaw = vi.fn().mockRejectedValue(new Error("connection refused"));
    const result = await checkDatabase(queryRaw);
    expect(result).toEqual({ reachable: false, user: null });
  });
});

describe("query timeouts", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const hang = () => new Promise<unknown[]>(() => {});

  it("checkDatabase fails with the failure shape when the query exceeds 5 s", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const pending = checkDatabase(hang);
    await vi.advanceTimersByTimeAsync(HEALTH_QUERY_TIMEOUT_MS + 1);
    await expect(pending).resolves.toEqual({ reachable: false, user: null });
  });

  it("checkMigrations fails with the failure shape when the query exceeds 5 s", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const pending = checkMigrations(hang);
    await vi.advanceTimersByTimeAsync(HEALTH_QUERY_TIMEOUT_MS + 1);
    await expect(pending).resolves.toEqual({ upToDate: false });
  });

  it("withStatementTimeout sets statement_timeout in the same transaction, before the query", async () => {
    const calls: string[] = [];
    const tx = {
      $executeRaw: vi.fn(async (strings: TemplateStringsArray) => {
        calls.push(strings.join(""));
      }),
      $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
        calls.push(strings.join(""));
        return [{ current_user: "app_runtime" }];
      }),
    };
    const client = { $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx) };
    const rows = await withStatementTimeout(client as never)`SELECT current_user`;
    expect(rows).toEqual([{ current_user: "app_runtime" }]);
    expect(calls[0]).toBe("SET LOCAL statement_timeout = '5000'");
    expect(calls[1]).toBe("SELECT current_user");
  });
});

describe("checkMigrations", () => {
  it("returns upToDate true when no pending migrations", async () => {
    const queryRaw = vi.fn().mockResolvedValue([{ count: BigInt(0) }]);
    const result = await checkMigrations(queryRaw);
    expect(result).toEqual({ upToDate: true });
  });

  it("returns upToDate false when pending migrations exist", async () => {
    const queryRaw = vi.fn().mockResolvedValue([{ count: BigInt(2) }]);
    const result = await checkMigrations(queryRaw);
    expect(result).toEqual({ upToDate: false });
  });

  it("returns upToDate false on query failure", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const queryRaw = vi.fn().mockRejectedValue(new Error("connection refused"));
    const result = await checkMigrations(queryRaw);
    expect(result).toEqual({ upToDate: false });
  });

  it("returns upToDate true when _prisma_migrations does not exist (existence check)", async () => {
    const queryRaw = vi.fn().mockResolvedValueOnce([{ present: false }]);
    const result = await checkMigrations(queryRaw);
    expect(result).toEqual({ upToDate: true });
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  it("returns upToDate true when the count query throws 'relation does not exist'", async () => {
    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce([{ present: true }])
      .mockRejectedValueOnce(new Error('relation "_prisma_migrations" does not exist'));
    expect(await checkMigrations(queryRaw)).toEqual({ upToDate: true });
  });

  it("returns upToDate true when the existence check throws 'relation does not exist'", async () => {
    const queryRaw = vi
      .fn()
      .mockRejectedValue(new Error('relation "_prisma_migrations" does not exist'));
    expect(await checkMigrations(queryRaw)).toEqual({ upToDate: true });
  });

  it("returns upToDate false when the count query fails for another reason", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce([{ present: true }])
      .mockRejectedValueOnce(new Error("permission denied"));
    expect(await checkMigrations(queryRaw)).toEqual({ upToDate: false });
  });

  it("shares one 5 s budget across both queries", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const queryRaw = vi.fn().mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve([{ present: true }]), 3000)),
    );
    const pending = checkMigrations(queryRaw);
    await vi.advanceTimersByTimeAsync(HEALTH_QUERY_TIMEOUT_MS + 1);
    await expect(pending).resolves.toEqual({ upToDate: false });
    vi.useRealTimers();
  });

  it("returns upToDate false when the table exists and migrations are pending", async () => {
    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce([{ present: true }])
      .mockResolvedValueOnce([{ count: 1 }]);
    expect(await checkMigrations(queryRaw)).toEqual({ upToDate: false });
  });
});

describe("runHealthChecks", () => {
  const ciEnv = {
    DATABASE_URL: "postgres://x",
    DATABASE_URL_UNPOOLED: "postgres://y",
    VERCEL_GIT_COMMIT_SHA: "abc123",
  };

  const productionEnv = {
    ...ciEnv,
    VERCEL_ENV: "production",
    BETTER_AUTH_SECRET: "s",
    APP_RUNTIME_PASSWORD: "p",
    RESEND_API_KEY: "r",
  };

  function makeQueryRaw(user = "app_runtime", pendingCount = BigInt(0)) {
    return vi.fn().mockImplementation(async (strings: TemplateStringsArray) => {
      const sql = strings.join("").trim();
      if (sql.includes("current_user")) {
        return [{ current_user: user }];
      }
      if (sql.includes("_prisma_migrations")) {
        return [{ count: pendingCount }];
      }
      return [];
    });
  }

  it("returns 200 in CI when only core env vars are present", async () => {
    const result = await runHealthChecks({
      env: ciEnv,
      queryRaw: makeQueryRaw(),
    });
    expect(result.status).toBe(200);
    expect(result.body.version).toBe("abc123");
    expect(result.body.database).toEqual({ reachable: true, user: "app_runtime" });
    expect(result.body.migrations).toEqual({ upToDate: true });
    expect(Object.values(result.body.env).every(Boolean)).toBe(true);
  });

  it("returns 200 in production when all vars present", async () => {
    const result = await runHealthChecks({
      env: productionEnv,
      queryRaw: makeQueryRaw(),
    });
    expect(result.status).toBe(200);
    expect(Object.keys(result.body.env)).toHaveLength(5);
  });

  it("returns 503 in production when a deploy env var is missing", async () => {
    const env = { ...productionEnv };
    delete (env as Record<string, string | undefined>).RESEND_API_KEY;
    const result = await runHealthChecks({
      env,
      queryRaw: makeQueryRaw(),
    });
    expect(result.status).toBe(503);
    expect(result.body.env.RESEND_API_KEY).toBe(false);
  });

  it("returns 503 when database is unreachable", async () => {
    const queryRaw = vi.fn().mockRejectedValue(new Error("connection refused"));
    const result = await runHealthChecks({
      env: ciEnv,
      queryRaw,
    });
    expect(result.status).toBe(503);
    expect(result.body.database.reachable).toBe(false);
  });

  it("returns 503 when migrations are pending", async () => {
    const result = await runHealthChecks({
      env: ciEnv,
      queryRaw: makeQueryRaw("app_runtime", BigInt(1)),
    });
    expect(result.status).toBe(503);
    expect(result.body.migrations.upToDate).toBe(false);
  });

  it("uses 'unknown' version when VERCEL_GIT_COMMIT_SHA is absent", async () => {
    const env = { DATABASE_URL: "postgres://x", DATABASE_URL_UNPOOLED: "postgres://y" };
    const result = await runHealthChecks({
      env,
      queryRaw: makeQueryRaw(),
    });
    expect(result.body.version).toBe("unknown");
  });
});

describe("toMinimalResult", () => {
  const body: HealthResult = {
    version: "abc123",
    database: { reachable: true, user: "app_runtime" },
    migrations: { upToDate: true },
    env: { DATABASE_URL: true },
  };

  it("returns ok for healthy status", () => {
    expect(toMinimalResult(200, body)).toEqual({
      status: "ok",
      version: "abc123",
    });
  });

  it("returns degraded for unhealthy status", () => {
    expect(toMinimalResult(503, body)).toEqual({
      status: "degraded",
      version: "abc123",
    });
  });

  it("never includes database or env details", () => {
    const result = toMinimalResult(200, body);
    expect(result).not.toHaveProperty("database");
    expect(result).not.toHaveProperty("env");
    expect(result).not.toHaveProperty("migrations");
  });
});

const hasDb = !!process.env.DATABASE_URL;
const hasRuntime = hasDb && !!process.env.APP_RUNTIME_PASSWORD;

describe.skipIf(!hasDb)("Health check DB integration", () => {
  let dbPrisma: PrismaClient;

  beforeAll(async () => {
    const url = runtimeDatabaseUrl(process.env as Record<string, string | undefined>);
    const adapter = new PrismaPg(url);
    dbPrisma = new PrismaClient({ adapter });
    await dbPrisma.$connect();
  });

  afterAll(async () => {
    await dbPrisma?.$disconnect();
  });

  it("checkDatabase returns reachable true against real DB", async () => {
    const queryRaw = dbPrisma.$queryRaw.bind(dbPrisma) as (
      strings: TemplateStringsArray,
      ...values: unknown[]
    ) => Promise<unknown[]>;
    const result = await checkDatabase(queryRaw);
    expect(result.reachable).toBe(true);
    expect(typeof result.user).toBe("string");
  });

  it("checkMigrations returns upToDate true (no pending)", async () => {
    const queryRaw = dbPrisma.$queryRaw.bind(dbPrisma) as (
      strings: TemplateStringsArray,
      ...values: unknown[]
    ) => Promise<unknown[]>;
    const result = await checkMigrations(queryRaw);
    expect(result.upToDate).toBe(true);
  });
});

describe.skipIf(!hasRuntime)("Health check proves app_runtime connection", () => {
  let runtimePrisma: PrismaClient;

  beforeAll(async () => {
    const url = runtimeDatabaseUrl(process.env as Record<string, string | undefined>);
    const adapter = new PrismaPg(url);
    runtimePrisma = new PrismaClient({ adapter });
    await runtimePrisma.$connect();
  });

  afterAll(async () => {
    await runtimePrisma?.$disconnect();
  });

  it("withStatementTimeout runs the real health queries well inside the timeout", async () => {
    const timed = withStatementTimeout(runtimePrisma as never);
    const started = Date.now();
    expect(await checkDatabase(timed)).toMatchObject({ reachable: true });
    expect((await checkMigrations(timed)).upToDate).toBe(true);
    expect(Date.now() - started).toBeLessThan(HEALTH_QUERY_TIMEOUT_MS);
  });

  it("the server cancels a query that exceeds the statement timeout", async () => {
    const timed = withStatementTimeout(runtimePrisma as never);
    await expect(timed`SELECT pg_sleep(6)`).rejects.toThrow(/statement timeout/i);
  }, 10_000);

  it("SELECT current_user returns app_runtime", async () => {
    const queryRaw = runtimePrisma.$queryRaw.bind(runtimePrisma) as (
      strings: TemplateStringsArray,
      ...values: unknown[]
    ) => Promise<unknown[]>;
    const result = await checkDatabase(queryRaw);
    expect(result.user).toBe("app_runtime");
  });
});
