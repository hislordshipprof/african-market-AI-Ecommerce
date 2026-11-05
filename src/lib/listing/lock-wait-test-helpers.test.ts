import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backendPid, pgError, waitForLockWait } from "./lock-wait-test-helpers";

const LOCK_SQL = "SELECT 1 FROM pg_locks WHERE pid = $1 AND NOT granted LIMIT 1";
const DEADLINE_ERROR = "the overlapping statement never waited on a lock";
const RLS_MESSAGE = /new row violates row-level security policy for table "stock_events"/i;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const SESSION = "lock-wait-t251";

type DatabaseEndpoint = { host: string; port: string; database: string };

type Scoped = {
  listing: {
    create: (args: { data: Record<string, unknown> }) => Promise<{ id: string }>;
  };
  stockEvent: {
    create: (args: { data: Record<string, unknown> }) => Promise<{ id: string }>;
    findMany: (args: { where: Record<string, unknown> }) => Promise<Array<{ id: string }>>;
    findUnique: (args: { where: { id: string } }) => Promise<{ id: string; storeId: string } | null>;
  };
};

function endpoint(connectionStringValue: string): DatabaseEndpoint {
  const url = new URL(connectionStringValue);
  return {
    host: url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/-pooler(?=\.)/g, ""),
    port: url.port || "5432",
    database: decodeURIComponent(url.pathname.replace(/^\//, "")),
  };
}

function sameHost(left: string, right: string): boolean {
  const local = (host: string) => (LOCAL_HOSTS.has(host) ? "127.0.0.1" : host);
  return local(left) === local(right);
}

/** Host and port that `pg` will actually use. Query `host` and `port` override the URL authority. */
function effectiveEndpoint(connectionStringValue: string): DatabaseEndpoint {
  const client = new Client({ connectionString: connectionStringValue });
  return {
    host: (client.host ?? "").toLowerCase().replace(/^\[|\]$/g, "").replace(/-pooler(?=\.)/g, ""),
    port: String(client.port || "5432"),
    database: client.database ?? "",
  };
}

function assertEffectiveEndpoint(label: string, connectionStringValue: string) {
  const authority = endpoint(connectionStringValue);
  const effective = effectiveEndpoint(connectionStringValue);
  if (
    !sameHost(authority.host, effective.host)
    || authority.port !== effective.port
    || authority.database !== effective.database
  ) {
    throw new Error(
      `${label} connects to ${effective.host}:${effective.port}/${effective.database} instead of ${authority.host}:${authority.port}/${authority.database}`,
    );
  }
}

function assertSameEndpoint(label: string, left: DatabaseEndpoint, right: DatabaseEndpoint) {
  if (!sameHost(left.host, right.host) || left.port !== right.port) {
    throw new Error(
      `${label} endpoint ${left.host}:${left.port} does not match DIRECT_URL endpoint ${right.host}:${right.port}`,
    );
  }
  if (left.database !== right.database) {
    throw new Error(
      `${label} database ${left.database} does not match DIRECT_URL database ${right.database}`,
    );
  }
}

/**
 * Refuse a helper-test target whose URLs differ, whose runtime password is missing,
 * or that is not a local lane or the hosted CI database. Synchronous on purpose:
 * a thrown error happens before any fixture connection.
 */
function assertLockWaitTarget(env: Record<string, string | undefined>): string {
  const pooled = env.DATABASE_URL?.trim();
  const direct = env.DIRECT_URL?.trim();
  const password = env.APP_RUNTIME_PASSWORD?.trim();
  if (!pooled || !direct) {
    throw new Error("DATABASE_URL and DIRECT_URL are required");
  }
  if (!password) {
    throw new Error("APP_RUNTIME_PASSWORD is required");
  }
  assertEffectiveEndpoint("DATABASE_URL", pooled);
  assertEffectiveEndpoint("DIRECT_URL", direct);
  const pooledEndpoint = endpoint(pooled);
  const directEndpoint = endpoint(direct);
  assertSameEndpoint("DATABASE_URL", pooledEndpoint, directEndpoint);
  const unpooled = env.DATABASE_URL_UNPOOLED?.trim();
  if (unpooled) {
    assertEffectiveEndpoint("DATABASE_URL_UNPOOLED", unpooled);
    assertSameEndpoint("DATABASE_URL_UNPOOLED", endpoint(unpooled), directEndpoint);
  }
  if (!LOCAL_HOSTS.has(directEndpoint.host)) {
    throw new Error(`migrate target host ${directEndpoint.host} is not a local disposable database`);
  }
  if (directEndpoint.database !== "test_db" && !/^lane_[a-z0-9_]+$/.test(directEndpoint.database)) {
    throw new Error(`migrate target database ${directEndpoint.database} is not a disposable local database`);
  }
  return direct;
}

function walkSources(visit: (file: string, source: string) => void) {
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.endsWith(".ts") && !entry.endsWith(".tsx")) continue;
      visit(full, readFileSync(full, "utf8"));
    }
  };
  walk(join(process.cwd(), "src"));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function keep(promise: Promise<unknown>): Promise<unknown> {
  promise.catch(() => undefined);
  return promise;
}

async function stillPending(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  await delay(40);
  return !settled;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => { throw new Error("expected the statement to fail"); },
    (error: unknown) => error,
  );
}

async function connect(direct: string, name = SESSION): Promise<Client> {
  const client = new Client({ connectionString: direct, application_name: name });
  await client.connect();
  return client;
}

async function countSessions(direct: string, name: string): Promise<number> {
  const probe = new Client({ connectionString: direct, application_name: "lock-wait-probe" });
  await probe.connect();
  try {
    const { rows } = await probe.query<{ n: number }>(
      "SELECT COUNT(*)::int AS n FROM pg_stat_activity WHERE application_name = $1",
      [name],
    );
    return rows[0].n;
  } finally {
    await probe.end();
  }
}

async function beginAsStore(client: Client, storeId: string) {
  await client.query("BEGIN");
  await client.query("SET LOCAL ROLE app_user");
  await client.query("SELECT set_config('app.store_id', $1, true)", [storeId]);
}

async function sampleWaiting(observer: Client, pid: number): Promise<boolean> {
  const { rows } = await observer.query(LOCK_SQL, [pid]);
  return rows.length > 0;
}

async function untilWaiting(observer: Client, pid: number) {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    if (await sampleWaiting(observer, pid)) return;
    await delay(25);
  }
  throw new Error("the fixture never showed an ungranted lock");
}

type HeldDelete = {
  holder: Client;
  waiter: Client;
  observer: Client;
  waiterPid: number;
  holderPid: number;
  deleting?: Promise<unknown>;
  extra: Client[];
};

async function releaseHeldDelete(held: Partial<HeldDelete>): Promise<string[]> {
  const order = ["holder-rollback"];
  if (held.holder) await held.holder.query("ROLLBACK").catch(() => undefined);
  order.push("waiter-drain");
  if (held.deleting) await held.deleting.catch(() => undefined);
  if (held.waiter) await held.waiter.query("ROLLBACK").catch(() => undefined);
  order.push("clients-ended");
  const clients = [held.holder, held.waiter, held.observer, ...(held.extra ?? [])];
  const ended = new Set<Client>();
  for (const client of clients) {
    if (!client || ended.has(client)) continue;
    ended.add(client);
    await client.end().catch(() => undefined);
  }
  return order;
}

async function finishCleanup(run: Promise<string[]>): Promise<string[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hung = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("cleanup hung; release the holder before draining the waiter")),
      5_000,
    );
  });
  try {
    return await Promise.race([run, hung]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe("lock-wait test helpers", () => {
  it("pgError maps non-errors and odd shapes to empty fields", () => {
    expect(pgError(null)).toEqual({ code: "", message: "" });
    expect(pgError(undefined)).toEqual({ code: "", message: "" });
    expect(pgError("boom")).toEqual({ code: "", message: "" });
    expect(pgError(42)).toEqual({ code: "", message: "" });
    expect(pgError({})).toEqual({ code: "", message: "" });
    expect(pgError({ code: 23503 })).toEqual({ code: "23503", message: "" });
    expect(pgError({ code: null })).toEqual({ code: "", message: "" });
    expect(pgError(new Error("x"))).toEqual({ code: "", message: "x" });
    expect(pgError({ code: "P2003", message: "m" })).toEqual({ code: "P2003", message: "" });
  });

  it("pgError preserves falsy and inherited codes", () => {
    expect(pgError({ code: 0 })).toEqual({ code: "0", message: "" });
    expect(pgError({ code: false })).toEqual({ code: "false", message: "" });
    expect(pgError({ code: undefined })).toEqual({ code: "", message: "" });
    const inherited = Object.create({ code: "42501" }) as object;
    expect(pgError(inherited)).toEqual({ code: "42501", message: "" });
  });

  it("lock-wait helper keeps the stock-event poll contract", () => {
    const source = readFileSync(join(process.cwd(), "src/lib/listing/lock-wait-test-helpers.ts"), "utf8");
    expect(source).toContain(LOCK_SQL);
    expect(source).toContain("8_000");
    expect(source).toContain("setTimeout(resolve, 25)");
    expect(source).toContain(`throw new Error("${DEADLINE_ERROR}")`);
    expect(source).toContain("App code must not import this module");
    expect(source).not.toMatch(/from ["']vitest["']/);
    expect(source).not.toContain("import-lock-test-helpers");
    expect(source).not.toContain("@/lib/db");
    expect(source).not.toMatch(/from ["']\.\.\/db["']/);
  });

  it("app code does not import the lock-wait test helper", () => {
    const importers: string[] = [];
    walkSources((file, source) => {
      const base = file.split(/[/\\]/).pop() ?? "";
      if (base.endsWith(".test.ts") || base === "lock-wait-test-helpers.ts") return;
      if (source.includes("lock-wait-test-helpers")) importers.push(file);
    });
    expect(importers).toEqual([]);
  });

  it("the stock-event suites use the shared lock-wait helper", () => {
    const isolation = readFileSync(join(process.cwd(), "src/lib/listing-isolation.test.ts"), "utf8");
    const migration = readFileSync(
      join(process.cwd(), "src/lib/listing/stock-events-same-store-migration.test.ts"),
      "utf8",
    );
    expect(isolation).toContain('from "./listing/lock-wait-test-helpers"');
    expect(migration).toContain('from "./lock-wait-test-helpers"');
    const helperNames = ["pgError", "backendPid", "waitForLockWait"] as const;
    for (const name of helperNames) {
      const declaration = new RegExp(`function ${name}\\b`);
      expect(isolation).not.toMatch(declaration);
      expect(migration).not.toMatch(declaration);
    }

    const hits: string[] = [];
    const decl = new RegExp(`function (${helperNames.join("|")})\\b`, "g");
    walkSources((file, source) => {
      const matches = source.match(decl);
      if (!matches) return;
      for (const match of matches) hits.push(`${file} ${match}`);
    });
    expect(hits).toHaveLength(3);
    expect(hits.every((hit) => hit.includes(`${join("src", "lib", "listing", "lock-wait-test-helpers.ts")}`))).toBe(true);
  });

  it("integration setup refuses incomplete and unsafe database targets", () => {
    const lane = {
      DATABASE_URL: "postgres://app_owner:pw@127.0.0.1:5434/lane_t251",
      DIRECT_URL: "postgres://app_owner:pw@127.0.0.1:5434/lane_t251",
      APP_RUNTIME_PASSWORD: "app_runtime_ci",
    };
    expect(() => assertLockWaitTarget({
      DATABASE_URL: lane.DATABASE_URL,
      APP_RUNTIME_PASSWORD: lane.APP_RUNTIME_PASSWORD,
    })).toThrow(/DATABASE_URL and DIRECT_URL are required/);
    expect(() => assertLockWaitTarget({
      DATABASE_URL: lane.DATABASE_URL,
      DIRECT_URL: lane.DIRECT_URL,
    })).toThrow(/APP_RUNTIME_PASSWORD is required/);
    expect(() => assertLockWaitTarget({
      ...lane,
      APP_RUNTIME_PASSWORD: "   ",
    })).toThrow(/APP_RUNTIME_PASSWORD is required/);
    expect(() => assertLockWaitTarget({
      ...lane,
      DIRECT_URL: "postgres://app_owner:pw@127.0.0.1:5434/other",
    })).toThrow(/DATABASE_URL database lane_t251 does not match DIRECT_URL database other/);
    expect(() => assertLockWaitTarget({
      ...lane,
      DATABASE_URL_UNPOOLED: "postgres://app_owner:pw@127.0.0.1:5434/neon_db",
    })).toThrow(/DATABASE_URL_UNPOOLED database neon_db does not match DIRECT_URL database lane_t251/);
    expect(() => assertLockWaitTarget({
      ...lane,
      DIRECT_URL: "postgres://app_owner:pw@other-host:5432/lane_t251",
    })).toThrow(/other-host:5432/);
    expect(() => assertLockWaitTarget({
      ...lane,
      DIRECT_URL: "postgres://app_owner:pw@127.0.0.1:5432/lane_t251",
    })).toThrow(/:5432/);
    expect(() => assertLockWaitTarget({
      DATABASE_URL: "postgres://app_owner:pw@ep-abc-pooler.region.aws.neon.tech:5432/lane_t251",
      DIRECT_URL: "postgres://app_owner:pw@ep-abc.region.aws.neon.tech:5432/lane_t251",
      APP_RUNTIME_PASSWORD: "app_runtime_ci",
    })).toThrow(/not a local disposable database/);
    expect(() => assertLockWaitTarget({
      DATABASE_URL: "postgres://app_owner:pw@127.0.0.1:5432/neondb",
      DIRECT_URL: "postgres://app_owner:pw@127.0.0.1:5432/neondb",
      APP_RUNTIME_PASSWORD: "app_runtime_ci",
    })).toThrow(/neondb/);
    const override = "postgres://app_owner:pw@localhost:5434/lane_t251?host=remote.example&port=6543";
    expect(() => assertLockWaitTarget({
      DATABASE_URL: override,
      DIRECT_URL: override,
      APP_RUNTIME_PASSWORD: "app_runtime_ci",
    })).toThrow(/remote\.example:6543/);

    const hosted = assertLockWaitTarget({
      DATABASE_URL: "postgres://app_owner:pw@localhost:5432/test_db",
      DIRECT_URL: "postgres://app_owner:pw@127.0.0.1:5432/test_db",
      APP_RUNTIME_PASSWORD: "app_runtime_ci",
    });
    expect(new URL(hosted).pathname).toBe("/test_db");
    const aliased = assertLockWaitTarget({
      DATABASE_URL: "postgres://app_owner:pw@localhost:5434/lane_t251",
      DIRECT_URL: "postgres://app_owner:pw@[::1]:5434/lane_t251",
      APP_RUNTIME_PASSWORD: "app_runtime_ci",
    });
    expect(new URL(aliased).pathname).toBe("/lane_t251");
    const explicit = assertLockWaitTarget({
      DATABASE_URL: "postgres://app_owner:pw@localhost:5432/test_db?sslmode=disable",
      DIRECT_URL: "postgres://app_owner:pw@127.0.0.1:5432/test_db?host=localhost&port=5432",
      APP_RUNTIME_PASSWORD: "app_runtime_ci",
    });
    expect(new URL(explicit).pathname).toBe("/test_db");
  });

  it.runIf(process.env.LOCK_WAIT_DB_FREE === "1")("isolated run has no database url", () => {
    expect(process.env.DATABASE_URL ?? "").toBe("");
    expect(process.env.DIRECT_URL ?? "").toBe("");
    expect(process.env.DATABASE_URL_UNPOOLED ?? "").toBe("");
    expect(process.env.APP_RUNTIME_PASSWORD ?? "").toBe("");
  });

  it.skipIf(process.env.LOCK_WAIT_DB_FREE === "1")(
    "database-free invocation executes pure tests and guards",
    () => {
      const configDir = mkdtempSync(join(tmpdir(), "lock-wait-db-free-"));
      const configPath = join(configDir, "vitest.config.mts");
      writeFileSync(
        configPath,
        `export default {
  root: ${JSON.stringify(process.cwd())},
  test: {
    environment: "node",
    include: ["src/lib/listing/lock-wait-test-helpers.test.ts"],
    setupFiles: [],
    fileParallelism: false,
    testTimeout: 40_000,
  },
};
`,
      );
      const env: NodeJS.ProcessEnv = { ...process.env, LOCK_WAIT_DB_FREE: "1" };
      delete env.DATABASE_URL;
      delete env.DIRECT_URL;
      delete env.DATABASE_URL_UNPOOLED;
      delete env.APP_RUNTIME_PASSWORD;
      try {
        const result = spawnSync(
          process.execPath,
          [
            join(process.cwd(), "node_modules/vitest/vitest.mjs"),
            "run",
            "--config",
            configPath,
            "--reporter=verbose",
            "src/lib/listing/lock-wait-test-helpers.test.ts",
          ],
          { cwd: process.cwd(), env, encoding: "utf8", timeout: 120_000 },
        );
        const output = `${result.stdout}\n${result.stderr}`;
        expect(result.status, output).toBe(0);
        expect(output).toContain("pgError maps non-errors and odd shapes to empty fields");
        expect(output).toContain("pgError preserves falsy and inherited codes");
        expect(output).toContain("app code does not import the lock-wait test helper");
        expect(output).toContain("the stock-event suites use the shared lock-wait helper");
        expect(output).toContain("integration setup refuses incomplete and unsafe database targets");
        expect(output).toContain("lock-wait helper keeps the stock-event poll contract");
        expect(output).toContain("helper imports without keys in production on Vercel");
        expect(output).toContain("isolated run has no database url");
        expect(output).not.toContain("FAIL");
        expect(output).toContain("skipped");
      } finally {
        rmSync(configDir, { recursive: true, force: true });
      }
    },
    150_000,
  );

  it("helper imports without keys in production on Vercel", () => {
    const dir = mkdtempSync(join(tmpdir(), "lock-wait-prod-"));
    const script = join(dir, "import-helper.mts");
    const helper = pathToFileURL(join(process.cwd(), "src/lib/listing/lock-wait-test-helpers.ts")).href;
    writeFileSync(
      script,
      `const started = Date.now();
const mod = await import(${JSON.stringify(helper)});
const parsed = mod.pgError({ code: 0 });
if (parsed.code !== "0" || parsed.message !== "") {
  console.error("unexpected pgError", JSON.stringify(parsed));
  process.exit(1);
}
if (typeof mod.backendPid !== "function" || typeof mod.waitForLockWait !== "function") {
  console.error("missing exports");
  process.exit(1);
}
if (Date.now() - started > 20_000) {
  console.error("import did too much work");
  process.exit(1);
}
console.log("imported-clean");
`,
    );
    const env = { ...process.env };
    for (const key of [
      "DATABASE_URL",
      "DIRECT_URL",
      "DATABASE_URL_UNPOOLED",
      "APP_RUNTIME_PASSWORD",
      "NEXT_PHASE",
    ]) {
      delete env[key];
    }
    env.NODE_ENV = "production";
    env.VERCEL = "1";
    try {
      const result = spawnSync(
        process.execPath,
        [join(process.cwd(), "node_modules/tsx/dist/cli.mjs"), script],
        { cwd: process.cwd(), env, encoding: "utf8", timeout: 30_000 },
      );
      const output = `${result.stdout}\n${result.stderr}`;
      expect(result.status, output).toBe(0);
      expect(result.stdout).toContain("imported-clean");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 40_000);
});

const dbEnabled = Boolean(process.env.DATABASE_URL?.trim());

describe.skipIf(!dbEnabled)("lock-wait helper on the lane database", () => {
  let directUrl = "";
  let storeScoped: (storeId: string) => Scoped;
  let disconnect: () => Promise<void>;
  let rawDisconnect: () => Promise<void> = async () => {};
  let storeAId = "";
  let storeBId = "";
  let userId = "";

  beforeAll(async () => {
    directUrl = assertLockWaitTarget(process.env);
    const db = await import("../db");
    const { PrismaClient } = await import("@prisma/client");
    const { PrismaPg } = await import("@prisma/adapter-pg");
    storeScoped = db.storeScoped as unknown as (storeId: string) => Scoped;
    disconnect = db.disconnectPlatformClient;
    expect(await db.platformSessionUser()).toBe("app_runtime");

    const rawPrisma = new PrismaClient({ adapter: new PrismaPg(process.env.DATABASE_URL!) });
    await rawPrisma.$connect();
    rawDisconnect = () => rawPrisma.$disconnect();

    const storeA = await rawPrisma.store.upsert({
      where: { slug: "lock-wait-a" },
      update: {},
      create: { slug: "lock-wait-a", name: "Lock Wait A", themePreset: "palm-and-shea" },
    });
    const storeB = await rawPrisma.store.upsert({
      where: { slug: "lock-wait-b" },
      update: {},
      create: { slug: "lock-wait-b", name: "Lock Wait B", themePreset: "lagoon-and-coral" },
    });
    const user = await rawPrisma.user.upsert({
      where: { email: "lock-wait-test@example.com" },
      update: {},
      create: {
        id: "lock-wait-user",
        email: "lock-wait-test@example.com",
        name: "Lock Wait User",
        emailVerified: true,
      },
    });
    storeAId = storeA.id;
    storeBId = storeB.id;
    userId = user.id;
  }, 60_000);

  afterAll(async () => {
    if (storeAId && storeBId) {
      const { PrismaClient } = await import("@prisma/client");
      const { PrismaPg } = await import("@prisma/adapter-pg");
      const rawPrisma = new PrismaClient({ adapter: new PrismaPg(process.env.DATABASE_URL!) });
      await rawPrisma.$connect();
      try {
        await rawPrisma.$transaction([
          rawPrisma.$executeRaw`SET LOCAL ROLE app_user`,
          rawPrisma.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
          rawPrisma.stockEvent.deleteMany({ where: { storeId: { in: [storeAId, storeBId] } } }),
          rawPrisma.listing.deleteMany({ where: { storeId: { in: [storeAId, storeBId] } } }),
        ]);
        await rawPrisma.user.deleteMany({ where: { email: "lock-wait-test@example.com" } });
        await rawPrisma.store.deleteMany({ where: { slug: { in: ["lock-wait-a", "lock-wait-b"] } } });
      } finally {
        await rawPrisma.$disconnect();
      }
    }
    await rawDisconnect();
    if (disconnect) await disconnect();
  }, 60_000);

  async function createListing(label: string): Promise<string> {
    const listing = await storeScoped(storeAId).listing.create({
      data: {
        storeId: storeAId,
        customName: `${label} ${randomUUID()}`,
        price: 100,
        stockMode: "counted",
        qty: 1,
        frozen: false,
        perishable: false,
      },
    });
    return listing.id;
  }

  async function openHeldInsert(listingId: string, name = SESSION): Promise<HeldDelete> {
    const acquired: Client[] = [];
    const held: Partial<HeldDelete> = { extra: [] };
    try {
      held.holder = await connect(directUrl, name);
      acquired.push(held.holder);
      held.waiter = await connect(directUrl, name);
      acquired.push(held.waiter);
      held.observer = await connect(directUrl, name);
      acquired.push(held.observer);
      await beginAsStore(held.holder, storeAId);
      await held.holder.query(
        `INSERT INTO stock_events (id, store_id, listing_id, type, delta, actor_id)
         VALUES ($1, $2, $3, 'adjust', 1, $4)`,
        [`lock-wait-hold-${randomUUID()}`, storeAId, listingId, userId],
      );
      await beginAsStore(held.waiter, storeAId);
      const ready: HeldDelete = {
        holder: held.holder,
        waiter: held.waiter,
        observer: held.observer,
        holderPid: await backendPid(held.holder),
        waiterPid: await backendPid(held.waiter),
        extra: [],
      };
      return ready;
    } catch (error) {
      await finishCleanup(releaseHeldDelete({ ...held, extra: acquired }));
      throw error;
    }
  }

  function startDelete(held: HeldDelete, listingId: string): Promise<unknown> {
    held.deleting = keep(held.waiter.query(`DELETE FROM listings WHERE id = $1`, [listingId]));
    return held.deleting;
  }

  it("waitForLockWait resolves while a delete waits behind a held stock event insert", async () => {
    const listingId = await createListing("Insert held");
    const held = await openHeldInsert(listingId);
    try {
      const deleting = startDelete(held, listingId);
      await waitForLockWait(held.observer, held.waiterPid);
      expect(await stillPending(deleting)).toBe(true);
      expect(await sampleWaiting(held.observer, held.waiterPid)).toBe(true);
      await held.holder.query("COMMIT");
      const deleteError = await rejection(deleting);
      expect(pgError(deleteError).code).toBe("23001");
      expect(pgError(deleteError).message).toMatch(/stock_events_listing_id_fkey/);
      await held.waiter.query("ROLLBACK");
      held.deleting = undefined;
    } finally {
      await finishCleanup(releaseHeldDelete(held));
    }
  }, 30_000);

  it("waitForLockWait keeps polling until a late waiter blocks", async () => {
    const listingId = await createListing("Late waiter");
    const held = await openHeldInsert(listingId);
    try {
      let settled = false;
      const waiting = waitForLockWait(held.observer, held.waiterPid);
      waiting.then(() => { settled = true; }, () => { settled = true; });
      await delay(200);
      expect(settled).toBe(false);
      const deleting = startDelete(held, listingId);
      await waiting;
      expect(await stillPending(deleting)).toBe(true);
    } finally {
      await finishCleanup(releaseHeldDelete(held));
    }
  }, 30_000);

  it("late waiter cannot resolve an empty poll early", async () => {
    const listingId = await createListing("Empty poll");
    const held = await openHeldInsert(listingId);
    const sampler = await connect(directUrl);
    held.extra.push(sampler);
    try {
      let empty = false;
      let markEmpty = () => {};
      const emptySeen = new Promise<void>((resolve) => { markEmpty = resolve; });
      const original = held.observer.query.bind(held.observer);
      held.observer.query = (async (text: unknown, values?: unknown[]) => {
        const result = await original(text as string, values);
        if (typeof text === "string" && text.includes("pg_locks") && result.rows.length === 0) {
          empty = true;
          markEmpty();
        }
        return result;
      }) as typeof held.observer.query;

      let settled = false;
      const waiting = waitForLockWait(held.observer, held.waiterPid);
      waiting.then(() => { settled = true; }, () => { settled = true; });
      await Promise.race([
        emptySeen,
        delay(2_000).then(() => { throw new Error("poll did not observe an empty lock sample"); }),
      ]);
      expect(empty).toBe(true);
      expect(settled).toBe(false);
      const submitted = Date.now();
      const deleting = startDelete(held, listingId);
      await waiting;
      expect(Date.now() - submitted).toBeLessThan(7_000);
      expect(await stillPending(deleting)).toBe(true);
      expect(await sampleWaiting(sampler, held.waiterPid)).toBe(true);
    } finally {
      await finishCleanup(releaseHeldDelete(held));
    }
  }, 30_000);

  it("waitForLockWait can be repeated and leaves the observer idle", async () => {
    const listingId = await createListing("Repeat poll");
    const held = await openHeldInsert(listingId);
    try {
      startDelete(held, listingId);
      await untilWaiting(held.observer, held.waiterPid);
      const seen: string[] = [];
      const original = held.observer.query.bind(held.observer);
      held.observer.query = (async (text: unknown, values?: unknown[]) => {
        if (typeof text === "string") seen.push(text);
        return original(text as string, values);
      }) as typeof held.observer.query;
      await waitForLockWait(held.observer, held.waiterPid);
      expect(held.observer.getTransactionStatus()).toBe("I");
      const beforeSecond = seen.length;
      await waitForLockWait(held.observer, held.waiterPid);
      expect(seen.length).toBeGreaterThan(beforeSecond);
      expect(held.observer.getTransactionStatus()).toBe("I");
      const locks = await original(
        "SELECT COUNT(*)::int AS n FROM pg_locks WHERE pid = $1 AND locktype = 'advisory'",
        [await backendPid(held.observer)],
      );
      expect(locks.rows[0].n).toBe(0);
    } finally {
      await finishCleanup(releaseHeldDelete(held));
    }
  }, 30_000);

  it("observer polling preserves caller transaction and rollback", async () => {
    const listingId = await createListing("Caller sentinel");
    const held = await openHeldInsert(listingId);
    const idle = await connect(directUrl);
    held.extra.push(idle);
    try {
      startDelete(held, listingId);
      await untilWaiting(held.observer, held.waiterPid);
      await held.observer.query("BEGIN");
      await held.observer.query("CREATE TEMP TABLE lock_wait_sentinel (n int)");
      await held.observer.query("INSERT INTO lock_wait_sentinel (n) VALUES (7)");
      await waitForLockWait(held.observer, held.waiterPid);
      const kept = await held.observer.query<{ n: number }>("SELECT n FROM lock_wait_sentinel");
      expect(kept.rows[0].n).toBe(7);
      expect(held.observer.getTransactionStatus()).toBe("T");
      await held.observer.query("ROLLBACK");
      expect(held.observer.getTransactionStatus()).toBe("I");
      const gone = await rejection(held.observer.query("SELECT n FROM lock_wait_sentinel"));
      expect(pgError(gone).code).toBe("42P01");

      await held.observer.query("BEGIN");
      await held.observer.query("CREATE TEMP TABLE lock_wait_sentinel (n int)");
      await held.observer.query("INSERT INTO lock_wait_sentinel (n) VALUES (9)");
      const idlePid = await backendPid(idle);
      const started = Date.now();
      const timedOut = await rejection(waitForLockWait(held.observer, idlePid));
      expect(Date.now() - started).toBeGreaterThanOrEqual(7_900);
      expect((timedOut as Error).message).toBe(DEADLINE_ERROR);
      const still = await held.observer.query<{ n: number }>("SELECT n FROM lock_wait_sentinel");
      expect(still.rows[0].n).toBe(9);
      expect(held.observer.getTransactionStatus()).toBe("T");
      await held.observer.query("ROLLBACK");
      expect(held.observer.getTransactionStatus()).toBe("I");
      const removed = await rejection(held.observer.query("SELECT n FROM lock_wait_sentinel"));
      expect(pgError(removed).code).toBe("42P01");
    } finally {
      await finishCleanup(releaseHeldDelete(held));
    }
  }, 30_000);

  it("polling only forwards the catalog query and target pid", async () => {
    const listingId = await createListing("Forwarded poll");
    const held = await openHeldInsert(listingId);
    const sampler = await connect(directUrl);
    held.extra.push(sampler);
    try {
      startDelete(held, listingId);
      await untilWaiting(sampler, held.waiterPid);
      const seen: Array<{ text: string; values: unknown[] | undefined }> = [];
      const original = held.observer.query.bind(held.observer);
      held.observer.query = (async (text: unknown, values?: unknown[]) => {
        seen.push({ text: String(text), values });
        return original(text as string, values);
      }) as typeof held.observer.query;
      await waitForLockWait(held.observer, held.waiterPid);
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every((call) => call.text === LOCK_SQL && Array.isArray(call.values) && call.values.length === 1 && call.values[0] === held.waiterPid)).toBe(true);
      expect(held.observer.getTransactionStatus()).toBe("I");
    } finally {
      await finishCleanup(releaseHeldDelete(held));
    }
  }, 30_000);

  it("observer query errors propagate without transaction recovery", async () => {
    const observer = await connect(directUrl);
    const idle = await connect(directUrl);
    try {
      await observer.query("BEGIN");
      const divided = await rejection(observer.query("SELECT 1/0"));
      expect(pgError(divided).code).toBe("22012");
      const idlePid = await backendPid(idle);
      const started = Date.now();
      const failed = await rejection(waitForLockWait(observer, idlePid));
      expect(Date.now() - started).toBeLessThan(1_500);
      expect(pgError(failed).code).toBe("25P02");
      expect((failed as Error).message).not.toBe(DEADLINE_ERROR);
      expect(observer.getTransactionStatus()).toBe("E");
      const still = await rejection(observer.query("SELECT 1"));
      expect(pgError(still).code).toBe("25P02");
      await observer.query("ROLLBACK");
      expect(observer.getTransactionStatus()).toBe("I");
      const recovered = await observer.query<{ ok: number }>("SELECT 1 AS ok");
      expect(recovered.rows[0].ok).toBe(1);
    } finally {
      await observer.query("ROLLBACK").catch(() => undefined);
      await observer.end().catch(() => undefined);
      await idle.end().catch(() => undefined);
    }
  }, 15_000);

  it("waitForLockWait rejects for a statement that fails fast with NOWAIT", async () => {
    const listingId = await createListing("Nowait");
    const holder = await connect(directUrl);
    const waiter = await connect(directUrl);
    const observer = await connect(directUrl);
    const idle = await connect(directUrl);
    const idleObserver = await connect(directUrl);
    try {
      await beginAsStore(holder, storeAId);
      await holder.query(`SELECT 1 FROM listings WHERE id = $1 FOR UPDATE`, [listingId]);
      await beginAsStore(waiter, storeAId);
      const waiterPid = await backendPid(waiter);
      const failed = await rejection(
        waiter.query(`SELECT 1 FROM listings WHERE id = $1 FOR UPDATE NOWAIT`, [listingId]),
      );
      expect(pgError(failed).code).toBe("55P03");
      const idlePid = await backendPid(idle);
      const started = Date.now();
      const [waiterPoll, idlePoll] = await Promise.all([
        rejection(waitForLockWait(observer, waiterPid)),
        rejection(waitForLockWait(idleObserver, idlePid)),
      ]);
      expect(Date.now() - started).toBeGreaterThanOrEqual(7_900);
      expect((waiterPoll as Error).message).toBe(DEADLINE_ERROR);
      expect((idlePoll as Error).message).toBe(DEADLINE_ERROR);
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      await waiter.query("ROLLBACK").catch(() => undefined);
      await holder.end().catch(() => undefined);
      await waiter.end().catch(() => undefined);
      await observer.end().catch(() => undefined);
      await idle.end().catch(() => undefined);
      await idleObserver.end().catch(() => undefined);
    }
  }, 30_000);

  it("waitForLockWait rejects for the holder pid", async () => {
    const listingId = await createListing("Holder pid");
    const held = await openHeldInsert(listingId);
    const sampler = await connect(directUrl);
    held.extra.push(sampler);
    try {
      expect(await sampleWaiting(sampler, held.holderPid)).toBe(false);
      const started = Date.now();
      const failed = await rejection(waitForLockWait(held.observer, held.holderPid));
      expect(Date.now() - started).toBeGreaterThanOrEqual(7_900);
      expect((failed as Error).message).toBe(DEADLINE_ERROR);
      expect(await sampleWaiting(sampler, held.holderPid)).toBe(false);
    } finally {
      await finishCleanup(releaseHeldDelete(held));
    }
  }, 30_000);

  it("waitForLockWait rejects for an idle pid while another session waits", async () => {
    const listingId = await createListing("Idle third");
    const held = await openHeldInsert(listingId);
    const sampler = await connect(directUrl);
    const idle = await connect(directUrl);
    held.extra.push(sampler, idle);
    try {
      const deleting = startDelete(held, listingId);
      await untilWaiting(sampler, held.waiterPid);
      const idlePid = await backendPid(idle);
      expect(idlePid).not.toBe(held.waiterPid);
      const started = Date.now();
      const failed = await rejection(waitForLockWait(held.observer, idlePid));
      expect(Date.now() - started).toBeGreaterThanOrEqual(7_900);
      expect((failed as Error).message).toBe(DEADLINE_ERROR);
      expect(await sampleWaiting(sampler, held.waiterPid)).toBe(true);
      expect(await stillPending(deleting)).toBe(true);
    } finally {
      await finishCleanup(releaseHeldDelete(held));
    }
  }, 30_000);

  it("overlapping polls keep their pid and deadline independent", async () => {
    const listingId = await createListing("Overlap polls");
    const held = await openHeldInsert(listingId);
    const sampler = await connect(directUrl);
    const idle = await connect(directUrl);
    const idleObserver = await connect(directUrl);
    held.extra.push(sampler, idle, idleObserver);
    try {
      const deleting = startDelete(held, listingId);
      await untilWaiting(sampler, held.waiterPid);
      const idlePid = await backendPid(idle);
      const started = Date.now();
      const blocked = waitForLockWait(held.observer, held.waiterPid).then(
        () => "resolved" as const,
        (error: unknown) => error,
      );
      const idlePoll = waitForLockWait(idleObserver, idlePid).then(
        () => "resolved" as const,
        (error: unknown) => error,
      );
      expect(await blocked).toBe("resolved");
      const early = await Promise.race([
        idlePoll.then((value) => ({ kind: "done" as const, value })),
        delay(500).then(() => ({ kind: "pending" as const })),
      ]);
      expect(early.kind).toBe("pending");
      const idleResult = await idlePoll;
      expect(Date.now() - started).toBeGreaterThanOrEqual(7_900);
      expect(idleResult).toBeInstanceOf(Error);
      expect((idleResult as Error).message).toBe(DEADLINE_ERROR);
      expect(await sampleWaiting(sampler, held.waiterPid)).toBe(true);
      expect(await stillPending(deleting)).toBe(true);
    } finally {
      await finishCleanup(releaseHeldDelete(held));
    }
  }, 30_000);

  it("waitForLockWait rejects for a pid with no backend after the deadline", async () => {
    const observer = await connect(directUrl);
    try {
      const started = Date.now();
      const failed = await rejection(waitForLockWait(observer, 2_147_483_647));
      const elapsed = Date.now() - started;
      expect(elapsed).toBeGreaterThanOrEqual(7_900);
      expect(failed).toBeInstanceOf(Error);
      expect((failed as Error).message).toBe(DEADLINE_ERROR);
      expect(pgError(failed)).toEqual({ code: "", message: DEADLINE_ERROR });
      const ping = await observer.query<{ ok: number }>("SELECT 1 AS ok");
      expect(ping.rows[0].ok).toBe(1);
      expect(observer.getTransactionStatus()).toBe("I");
    } finally {
      await observer.end().catch(() => undefined);
    }
    expect(await countSessions(directUrl, SESSION)).toBe(0);
  }, 30_000);

  it("backendPid returns each supplied client session pid", async () => {
    const first = await connect(directUrl);
    const second = await connect(directUrl);
    try {
      const helperFirst = await backendPid(first);
      const rawFirst = await first.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      const helperSecond = await backendPid(second);
      const rawSecond = await second.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      expect(helperFirst).toBe(rawFirst.rows[0].pid);
      expect(helperSecond).toBe(rawSecond.rows[0].pid);
      expect(helperFirst).not.toBe(helperSecond);
      expect(typeof helperFirst).toBe("number");
    } finally {
      await first.end().catch(() => undefined);
      await second.end().catch(() => undefined);
    }
  }, 20_000);

  it("failure cleanup releases holder before draining waiter", async () => {
    const name = `lock-wait-cleanup-${randomUUID()}`;
    const listingId = await createListing("Cleanup");
    const held = await openHeldInsert(listingId, name);
    const sampler = await connect(directUrl, "lock-wait-probe");
    try {
      startDelete(held, listingId);
      await untilWaiting(sampler, held.waiterPid);
      throw new Error("forced failure");
    } catch (error) {
      expect((error as Error).message).toBe("forced failure");
    } finally {
      await sampler.end().catch(() => undefined);
      const order = await finishCleanup(releaseHeldDelete(held));
      expect(order).toEqual(["holder-rollback", "waiter-drain", "clients-ended"]);
    }
    expect(await countSessions(directUrl, name)).toBe(0);

    const partial = `lock-wait-partial-${randomUUID()}`;
    const acquired: Client[] = [];
    const refused = new URL(directUrl);
    refused.hostname = "127.0.0.1";
    refused.port = "1";
    refused.username = "lock-wait-none";
    refused.password = "invalid";
    try {
      acquired.push(await connect(directUrl, partial));
      const bad = new Client({
        connectionString: refused.toString(),
        connectionTimeoutMillis: 800,
      });
      await bad.connect();
      acquired.push(bad);
      throw new Error("bad connection should have failed");
    } catch (error) {
      expect((error as Error).message).not.toBe("bad connection should have failed");
    } finally {
      for (const client of acquired) await client.end().catch(() => undefined);
    }
    expect(await countSessions(directUrl, partial)).toBe(0);
  }, 30_000);

  it("pgError reads SQLSTATE and message from real pg rejections", async () => {
    const visible = await createListing("Rls visible");
    const rlsClient = await connect(directUrl);
    try {
      await beginAsStore(rlsClient, storeBId);
      const rejected = await rejection(rlsClient.query(
        `INSERT INTO stock_events (id, store_id, listing_id, type, delta, actor_id)
         VALUES ($1, $2, $3, 'adjust', 1, $4)`,
        [`lock-wait-rls-${randomUUID()}`, storeBId, visible, userId],
      ));
      expect(pgError(rejected).code).toBe("42501");
      expect(pgError(rejected).message).toMatch(RLS_MESSAGE);
      expect(pgError(rejected).message).toBe((rejected as Error).message);
      expect(pgError(rejected).message).not.toMatch(/stock_events_listing_id_fkey/);
    } finally {
      await rlsClient.query("ROLLBACK").catch(() => undefined);
      await rlsClient.end().catch(() => undefined);
    }

    const doomed = await createListing("Delete wins");
    const holder = await connect(directUrl);
    const waiter = await connect(directUrl);
    const observer = await connect(directUrl);
    try {
      await beginAsStore(holder, storeAId);
      const removed = await holder.query(`DELETE FROM listings WHERE id = $1`, [doomed]);
      expect(removed.rowCount).toBe(1);
      await beginAsStore(waiter, storeAId);
      const insertPid = await backendPid(waiter);
      const inserting = keep(waiter.query(
        `INSERT INTO stock_events (id, store_id, listing_id, type, delta, actor_id)
         VALUES ($1, $2, $3, 'adjust', 1, $4)`,
        [`lock-wait-fk-${randomUUID()}`, storeAId, doomed, userId],
      ));
      await waitForLockWait(observer, insertPid);
      expect(await stillPending(inserting)).toBe(true);
      await holder.query("COMMIT");
      const insertError = await rejection(inserting);
      expect(pgError(insertError).code).toBe("23503");
      expect(pgError(insertError).message).toMatch(/stock_events_listing_id_fkey/);
      expect(pgError(insertError).message).toBe((insertError as Error).message);
      await waiter.query("ROLLBACK");
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      await waiter.query("ROLLBACK").catch(() => undefined);
      await holder.end().catch(() => undefined);
      await waiter.end().catch(() => undefined);
      await observer.end().catch(() => undefined);
    }

    const lockedListing = await createListing("Lock timeout");
    const locker = await connect(directUrl);
    const blocked = await connect(directUrl);
    try {
      await beginAsStore(locker, storeAId);
      await locker.query(`SELECT 1 FROM listings WHERE id = $1 FOR UPDATE`, [lockedListing]);
      await beginAsStore(blocked, storeAId);
      await blocked.query("SET LOCAL lock_timeout = '200ms'");
      const timedOut = await rejection(
        blocked.query(`SELECT 1 FROM listings WHERE id = $1 FOR UPDATE`, [lockedListing]),
      );
      expect(pgError(timedOut).code).toBe("55P03");
      expect(pgError(timedOut).message).toMatch(/lock timeout/i);
      expect(pgError(timedOut).message).toBe((timedOut as Error).message);
    } finally {
      await locker.query("ROLLBACK").catch(() => undefined);
      await blocked.query("ROLLBACK").catch(() => undefined);
      await locker.end().catch(() => undefined);
      await blocked.end().catch(() => undefined);
    }
  }, 30_000);

  it("pgError keeps the RLS message from a storeScoped cross-store stock event write", async () => {
    const listingId = await createListing("Scoped message");
    const eventId = `lock-wait-msg-${randomUUID()}`;
    const rejected = await rejection(storeScoped(storeBId).stockEvent.create({
      data: {
        id: eventId,
        storeId: storeBId,
        listingId,
        type: "adjust",
        delta: 1,
        actorId: userId,
      },
    }));
    expect(pgError(rejected).message).toMatch(/42501|row-level security/i);
    expect(pgError(rejected).message).toBe((rejected as Error).message);
    expect(await storeScoped(storeAId).stockEvent.findMany({ where: { id: eventId } })).toEqual([]);
    expect(await storeScoped(storeBId).stockEvent.findMany({ where: { id: eventId } })).toEqual([]);
  }, 20_000);

  it("cross-store rejection preserves Prisma fields and writes no event in either store", async () => {
    const listingId = await createListing("Scoped fields");
    const eventId = `lock-wait-foreign-${randomUUID()}`;
    const controlId = `lock-wait-own-${randomUUID()}`;
    const rejected = await rejection(storeScoped(storeBId).stockEvent.create({
      data: {
        id: eventId,
        storeId: storeBId,
        listingId,
        type: "adjust",
        delta: 1,
        actorId: userId,
      },
    }));
    const parsed = pgError(rejected);
    const thrown = rejected as { code?: unknown; message?: unknown };
    expect(parsed.code).toBe(thrown.code == null ? "" : String(thrown.code));
    expect(parsed.message).toBe(rejected instanceof Error ? rejected.message : "");
    expect(parsed.message).toMatch(RLS_MESSAGE);
    expect(parsed.code).not.toBe("P2003");
    expect(parsed.message).not.toMatch(/stock_events_listing_id_fkey/);
    expect(await storeScoped(storeAId).stockEvent.findMany({ where: { id: eventId } })).toEqual([]);
    expect(await storeScoped(storeBId).stockEvent.findMany({ where: { id: eventId } })).toEqual([]);

    const control = await storeScoped(storeAId).stockEvent.create({
      data: {
        id: controlId,
        storeId: storeAId,
        listingId,
        type: "adjust",
        delta: 2,
        actorId: userId,
      },
    });
    expect(control.id).toBe(controlId);
    expect(await storeScoped(storeAId).stockEvent.findUnique({ where: { id: controlId } })).toMatchObject({
      id: controlId,
      storeId: storeAId,
    });
    expect(await storeScoped(storeBId).stockEvent.findMany({ where: { id: controlId } })).toEqual([]);
  }, 20_000);
});
