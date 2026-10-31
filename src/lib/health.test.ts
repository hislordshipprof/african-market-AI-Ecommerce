import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { checkEnv, checkDatabase, checkMigrations, runHealthChecks } from "./health";
import { runtimeDatabaseUrl } from "./env";

describe("checkEnv", () => {
  it("returns all true when every required var is present", () => {
    const env = {
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

  it("reports missing vars as false", () => {
    const env = {
      DATABASE_URL: "postgres://x",
    };
    const result = checkEnv(env);
    expect(result.BETTER_AUTH_SECRET).toBe(false);
    expect(result.APP_RUNTIME_PASSWORD).toBe(false);
    expect(result.RESEND_API_KEY).toBe(false);
    expect(result.DATABASE_URL).toBe(true);
    expect(result.DATABASE_URL_UNPOOLED).toBe(false);
  });

  it("accepts DIRECT_URL as satisfying DATABASE_URL_UNPOOLED", () => {
    const env = {
      BETTER_AUTH_SECRET: "s",
      APP_RUNTIME_PASSWORD: "p",
      RESEND_API_KEY: "r",
      DATABASE_URL: "postgres://x",
      DIRECT_URL: "postgres://z",
    };
    const result = checkEnv(env);
    expect(result.DATABASE_URL_UNPOOLED).toBe(true);
  });

  it("never exposes env var values", () => {
    const env = {
      BETTER_AUTH_SECRET: "super-secret",
      APP_RUNTIME_PASSWORD: "pw",
      RESEND_API_KEY: "key",
      DATABASE_URL: "postgres://user:pass@host/db",
      DATABASE_URL_UNPOOLED: "postgres://user:pass@host/db",
    };
    const result = checkEnv(env);
    const json = JSON.stringify(result);
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
    const queryRaw = vi.fn().mockRejectedValue(new Error("table not found"));
    const result = await checkMigrations(queryRaw);
    expect(result).toEqual({ upToDate: false });
  });
});

describe("runHealthChecks", () => {
  const fullEnv = {
    BETTER_AUTH_SECRET: "s",
    APP_RUNTIME_PASSWORD: "p",
    RESEND_API_KEY: "r",
    DATABASE_URL: "postgres://x",
    DATABASE_URL_UNPOOLED: "postgres://y",
    VERCEL_GIT_COMMIT_SHA: "abc123",
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

  it("returns 200 when all checks pass", async () => {
    const result = await runHealthChecks({
      env: fullEnv,
      queryRaw: makeQueryRaw(),
    });
    expect(result.status).toBe(200);
    expect(result.body.version).toBe("abc123");
    expect(result.body.database).toEqual({ reachable: true, user: "app_runtime" });
    expect(result.body.migrations).toEqual({ upToDate: true });
    expect(Object.values(result.body.env).every(Boolean)).toBe(true);
  });

  it("returns 503 when a required env var is missing", async () => {
    const env = { ...fullEnv };
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
      env: fullEnv,
      queryRaw,
    });
    expect(result.status).toBe(503);
    expect(result.body.database.reachable).toBe(false);
  });

  it("returns 503 when migrations are pending", async () => {
    const result = await runHealthChecks({
      env: fullEnv,
      queryRaw: makeQueryRaw("app_runtime", BigInt(1)),
    });
    expect(result.status).toBe(503);
    expect(result.body.migrations.upToDate).toBe(false);
  });

  it("uses 'unknown' version when VERCEL_GIT_COMMIT_SHA is absent", async () => {
    const env = { ...fullEnv };
    delete (env as Record<string, string | undefined>).VERCEL_GIT_COMMIT_SHA;
    const result = await runHealthChecks({
      env,
      queryRaw: makeQueryRaw(),
    });
    expect(result.body.version).toBe("unknown");
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

  it("SELECT current_user returns app_runtime", async () => {
    const queryRaw = runtimePrisma.$queryRaw.bind(runtimePrisma) as (
      strings: TemplateStringsArray,
      ...values: unknown[]
    ) => Promise<unknown[]>;
    const result = await checkDatabase(queryRaw);
    expect(result.user).toBe("app_runtime");
  });
});
