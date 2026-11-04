import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { Client } from "pg";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const execFileAsync = promisify(execFile);

const ROOT = path.resolve(__dirname, "../../..");
const MIGRATIONS = path.join(ROOT, "prisma/migrations");
const TARGET = "20261104200000_stock_events_same_store";
const MIGRATION_FILE = path.join(MIGRATIONS, TARGET, "migration.sql");
const PRISMA_CLI = path.join(ROOT, "node_modules/prisma/build/index.js");
const TSX_CLI = path.join(ROOT, "node_modules/tsx/dist/cli.mjs");
const REPLAY_LOCK = 199031030;
const ABORT_SCHEMA = "tmp_se235_abort";
const APPLY_SCHEMA = "tmp_se235_apply";
const HOLD_SCHEMA = "tmp_se235_hold";
const RLS_MESSAGE = 'new row violates row-level security policy for table "stock_events"';

// Replays into a scratch schema. stock_events and listings have forced RLS, and the
// migrating role in CI and lanes (app_owner) is not BYPASSRLS, so a mismatch count
// without app.is_platform_admin sees zero rows. RLS stays enabled and forced through
// the target migration; the admin flag is used only to seed fixture rows, then cleared.
// The scratch schema is dropped afterwards. Do not point this file at Neon.

const connectionString = process.env.DIRECT_URL ?? process.env.DATABASE_URL;

function databaseName(connectionStringValue: string): string {
  return decodeURIComponent(new URL(connectionStringValue).pathname.replace(/^\//, ""));
}

function loginRole(connectionStringValue: string): string {
  return decodeURIComponent(new URL(connectionStringValue).username);
}

/** Refuse a migrate target whose direct, pooled and unpooled URLs name different databases. */
export function assertSameDatabase(env: NodeJS.ProcessEnv): string {
  const pooled = env.DATABASE_URL?.trim();
  const direct = env.DIRECT_URL?.trim();
  if (!pooled || !direct) {
    throw new Error("DATABASE_URL and DIRECT_URL are required");
  }
  const pooledName = databaseName(pooled);
  const directName = databaseName(direct);
  if (pooledName !== directName) {
    throw new Error(
      `DIRECT_URL database ${directName} does not match DATABASE_URL database ${pooledName}`,
    );
  }
  const unpooled = env.DATABASE_URL_UNPOOLED?.trim();
  if (unpooled) {
    const unpooledName = databaseName(unpooled);
    if (unpooledName !== directName) {
      throw new Error(
        `DATABASE_URL_UNPOOLED database ${unpooledName} does not match DIRECT_URL database ${directName}`,
      );
    }
  }
  return direct;
}

function withDatabase(base: string, database: string): string {
  if (!/^[a-z0-9_]+$/.test(database)) throw new Error("unexpected database name");
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

function redact(text: string): string {
  return text.replace(/postgres(?:ql)?:\/\/\S+/gi, "postgres://redacted");
}

function assertSchema(schema: string) {
  if (!/^tmp_se235_[a-z]+$/.test(schema)) throw new Error("unexpected schema");
}

function migrationSql(): string {
  return fs.readFileSync(MIGRATION_FILE, "utf8");
}

function stripSqlComments(sql: string): string {
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .trim();
}

type PolicyRow = {
  policyname: string;
  permissive: string;
  roles: string;
  cmd: string;
  qual: string | null;
  with_check: string | null;
};

type EventRow = {
  id: string;
  store_id: string;
  listing_id: string;
  type: string;
  delta: number;
  actor_id: string;
  created_at: string;
};

function pgError(error: unknown): { code: string; message: string } {
  if (typeof error === "object" && error !== null) {
    const code = "code" in error && error.code != null ? String(error.code) : "";
    const message = error instanceof Error ? error.message : "";
    return { code, message };
  }
  return { code: "", message: "" };
}

describe("stock_events same-store migration file", () => {
  const raw = migrationSql();
  const sql = stripSqlComments(raw);

  it("the migration is one guard block followed by one ALTER POLICY", () => {
    expect(sql.startsWith("DO $$")).toBe(true);
    expect(sql.endsWith("$$;")).toBe(true);
    expect(sql.match(/\bDO\b/g)).toHaveLength(1);
    expect(sql.match(/ALTER POLICY/g)).toHaveLength(1);
    expect(sql).not.toMatch(/DROP POLICY/);
    expect(sql).not.toMatch(/DISABLE ROW LEVEL SECURITY/);
    expect(sql).not.toMatch(/^\s*BEGIN\s*;/m);
    expect(sql).not.toMatch(/^\s*COMMIT\s*;/m);
    const listingsLock = sql.indexOf('LOCK TABLE "listings" IN SHARE ROW EXCLUSIVE MODE');
    const eventsLock = sql.indexOf('LOCK TABLE "stock_events" IN SHARE ROW EXCLUSIVE MODE');
    const adminOn = sql.indexOf("set_config('app.is_platform_admin', 'true', true)");
    const counted = sql.indexOf("s.store_id <> l.store_id");
    const adminOff = sql.indexOf("set_config('app.is_platform_admin', 'false', true)");
    const raised = sql.indexOf(
      "RAISE EXCEPTION 'stock_events rows reference a listing in another store: %'",
    );
    const altered = sql.indexOf("ALTER POLICY stock_events_isolation");
    expect(listingsLock).toBeGreaterThan(-1);
    expect(listingsLock).toBeLessThan(eventsLock);
    expect(eventsLock).toBeLessThan(adminOn);
    expect(adminOn).toBeLessThan(counted);
    expect(counted).toBeLessThan(adminOff);
    expect(adminOff).toBeLessThan(raised);
    expect(raised).toBeLessThan(altered);
    expect(raw).toContain(
      "prisma migrate resolve --rolled-back 20261104200000_stock_events_same_store",
    );
    expect(raw).toContain("Do not delete stock events");
  });

  it("refuses a direct URL that names a different database than the app URL", () => {
    expect(() => assertSameDatabase({
      DATABASE_URL: "postgres://app_owner:pw@127.0.0.1:5434/lane_t235",
      DIRECT_URL: "postgres://app_owner:pw@127.0.0.1:5434/other",
    })).toThrow(/DIRECT_URL database other does not match DATABASE_URL database lane_t235/);
  });

  it("refuses an unpooled URL that names a different database", () => {
    expect(() => assertSameDatabase({
      DATABASE_URL: "postgres://app_owner:pw@127.0.0.1:5434/lane_t235",
      DIRECT_URL: "postgres://app_owner:pw@127.0.0.1:5434/lane_t235",
      DATABASE_URL_UNPOOLED: "postgres://app_owner:pw@127.0.0.1:5434/neon_db",
    })).toThrow(/DATABASE_URL_UNPOOLED database neon_db does not match DIRECT_URL database lane_t235/);
  });

  it("refuses to migrate when the direct URL is missing", () => {
    expect(() => assertSameDatabase({ DATABASE_URL: "postgres://app_owner:pw@127.0.0.1:5434/lane_t235" }))
      .toThrow(/DATABASE_URL and DIRECT_URL are required/);
  });
});

describe.skipIf(!connectionString)("stock_events same-store migration replay", () => {
  const client = new Client({ connectionString });
  const role = loginRole(connectionString!);

  beforeAll(async () => {
    await client.connect();
    await client.query("SELECT pg_advisory_lock($1)", [REPLAY_LOCK]);
    try {
      await replay(client, ABORT_SCHEMA, false);
      await seedHistory(client, true);
      await replay(client, APPLY_SCHEMA, true);
      await seedHistory(client, false);
      await replay(client, HOLD_SCHEMA, false);
      await seedHistory(client, false);
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [REPLAY_LOCK]);
    }
  }, 300_000);

  afterAll(async () => {
    await client.query("ROLLBACK").catch(() => undefined);
    await client.query("RESET ROLE").catch(() => undefined);
    for (const schema of [ABORT_SCHEMA, APPLY_SCHEMA, HOLD_SCHEMA]) {
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    }
    await client.end();
  });

  async function use(schema: string) {
    assertSchema(schema);
    await client.query("ROLLBACK").catch(() => undefined);
    await client.query("RESET ROLE");
    await client.query(`SET search_path = ${schema}`);
    const current = await client.query<{ schema: string }>("SELECT current_schema() AS schema");
    expect(current.rows[0].schema).toBe(schema);
  }

  it("the stock_events same-store migration aborts on a mismatched row while RLS is forced", async () => {
    await use(ABORT_SCHEMA);
    await expectForcedOwner(client, ABORT_SCHEMA, role);
    const before = await policies(client, ABORT_SCHEMA);
    const history = await eventRows(client);
    await expect(client.query(migrationSql())).rejects.toThrow(
      /stock_events rows reference a listing in another store: 3/,
    );
    expect(await adminFlag(client)).not.toBe("true");
    expect(await policies(client, ABORT_SCHEMA)).toEqual(before);
    expect(await eventRows(client)).toEqual(history);
    const isolation = before.find((row) => row.policyname === "stock_events_isolation");
    expect(isolation?.qual ?? "").not.toMatch(/EXISTS/);
    expect(isolation?.with_check ?? "").not.toMatch(/EXISTS/);
    expect(isolation?.roles).toBe("{app_user}");
  });

  it("guard counts all mismatches and preserves valid history under forced RLS", async () => {
    await use(ABORT_SCHEMA);
    const before = await eventRows(client);
    expect(before).toEqual([
      expect.objectContaining({ id: "ev-bad-1", store_id: "sB", listing_id: "lA", delta: 1 }),
      expect.objectContaining({ id: "ev-bad-2", store_id: "sC", listing_id: "lA", delta: 2 }),
      expect.objectContaining({ id: "ev-bad-3", store_id: "sA", listing_id: "lB", delta: 9 }),
      expect.objectContaining({ id: "ev-valid-a", store_id: "sA", listing_id: "lA", type: "recount", delta: 4, actor_id: "u235" }),
      expect.objectContaining({ id: "ev-valid-b", store_id: "sB", listing_id: "lB", type: "adjust", delta: -2, actor_id: "u235" }),
    ]);
    await expect(client.query(migrationSql())).rejects.toThrow(
      /stock_events rows reference a listing in another store: 3/,
    );
    expect(await eventRows(client)).toEqual(before);
  });

  it("policy installation failure preserves policy and clears elevation", async () => {
    await use(HOLD_SCHEMA);
    const before = await policies(client, HOLD_SCHEMA);
    const history = await eventRows(client);
    const blocker = await connectSchema(HOLD_SCHEMA);
    try {
      await blocker.query("BEGIN");
      await blocker.query('LOCK TABLE "stock_events" IN SHARE ROW EXCLUSIVE MODE');
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout = '1s'");
      const locked = await client.query(migrationSql()).then(
        () => null,
        (error: unknown) => error,
      );
      expect(pgError(locked).code).toBe("55P03");
      await client.query("ROLLBACK");
      expect(await adminFlag(client)).not.toBe("true");
      expect(await policies(client, HOLD_SCHEMA)).toEqual(before);
      expect(await eventRows(client)).toEqual(history);
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      await blocker.end();
    }

    await use(HOLD_SCHEMA);
    await client.query("BEGIN");
    await client.query("ALTER POLICY stock_events_isolation ON stock_events RENAME TO stock_events_isolation_off");
    const renamed = await client.query(migrationSql()).then(
      () => null,
      (error: unknown) => error,
    );
    expect(pgError(renamed).message).toMatch(/stock_events_isolation/);
    await client.query("ROLLBACK");
    expect(await adminFlag(client)).not.toBe("true");
    expect(await policies(client, HOLD_SCHEMA)).toEqual(before);
    expect(await eventRows(client)).toEqual(history);
  }, 30_000);

  it("guard and policy installation exclude concurrent mismatched writers", async () => {
    await use(HOLD_SCHEMA);
    const writer = await connectSchema(HOLD_SCHEMA);
    const migrator = await connectSchema(HOLD_SCHEMA);
    try {
      await writer.query("BEGIN");
      await writer.query("SET LOCAL ROLE app_user");
      await writer.query("SELECT set_config('app.store_id', 'sB', true)");
      await writer.query(
        `INSERT INTO stock_events (id, store_id, listing_id, type, delta, actor_id)
         VALUES ('ev-race', 'sB', 'lA', 'adjust', 7, 'u235')`,
      );
      const migratorPid = await backendPid(migrator);
      const migrating = migrator.query(migrationSql());
      expect(await Promise.race([
        waitForLockWait(client, migratorPid).then(() => "waiting"),
        migrating.then(() => "committed", () => "failed-early"),
      ])).toBe("waiting");
      await writer.query("COMMIT");
      const aborted = await migrating.then(
        () => null,
        (error: unknown) => error,
      );
      expect(pgError(aborted).message).toMatch(
        /stock_events rows reference a listing in another store: 1/,
      );
      const isolation = (await policies(client, HOLD_SCHEMA)).find((row) => row.policyname === "stock_events_isolation");
      expect(isolation?.qual ?? "").not.toMatch(/EXISTS/);
      const raced = (await eventRows(client)).find((row) => row.id === "ev-race");
      expect(raced).toMatchObject({ store_id: "sB", listing_id: "lA", delta: 7 });

      await client.query("BEGIN");
      await client.query("SELECT set_config('app.is_platform_admin', 'true', true)");
      await client.query("DELETE FROM stock_events WHERE id = 'ev-race'");
      await client.query("SELECT set_config('app.is_platform_admin', 'false', true)");
      await client.query("COMMIT");

      await migrator.query("BEGIN");
      await migrator.query(migrationSql());
      const listingWriter = await connectSchema(HOLD_SCHEMA);
      try {
        await listingWriter.query("BEGIN");
        await listingWriter.query("SELECT set_config('app.is_platform_admin', 'true', true)");
        const listingPid = await backendPid(listingWriter);
        const relocking = listingWriter.query("UPDATE listings SET price = 101 WHERE id = 'lA'");
        expect(await Promise.race([
          waitForLockWait(client, listingPid).then(() => "waiting"),
          relocking.then(() => "committed", () => "failed-early"),
        ])).toBe("waiting");
        await writer.query("BEGIN");
        await writer.query("SET LOCAL ROLE app_user");
        await writer.query("SELECT set_config('app.store_id', 'sB', true)");
        const writerPid = await backendPid(writer);
        const inserting = writer.query(
          `INSERT INTO stock_events (id, store_id, listing_id, type, delta, actor_id)
           VALUES ('ev-late', 'sB', 'lA', 'adjust', 8, 'u235')`,
        );
        expect(await Promise.race([
          waitForLockWait(client, writerPid).then(() => "waiting"),
          inserting.then(() => "committed", () => "failed-early"),
        ])).toBe("waiting");
        await migrator.query("COMMIT");
        const rejected = await inserting.then(
          () => null,
          (error: unknown) => error,
        );
        expect(pgError(rejected).code).toBe("42501");
        expect(pgError(rejected).message).toContain(RLS_MESSAGE);
        await writer.query("ROLLBACK");
        const relocked = await relocking;
        expect(relocked.rowCount).toBe(1);
        await listingWriter.query("COMMIT");
        expect((await eventRows(client)).some((row) => row.id === "ev-late")).toBe(false);
        const installed = (await policies(client, HOLD_SCHEMA)).find((row) => row.policyname === "stock_events_isolation");
        expect(installed?.qual ?? "").toMatch(/EXISTS/);
        expect(installed?.with_check ?? "").toMatch(/EXISTS/);
      } finally {
        await listingWriter.query("ROLLBACK").catch(() => undefined);
        await listingWriter.end();
      }
    } finally {
      await writer.query("ROLLBACK").catch(() => undefined);
      await migrator.query("ROLLBACK").catch(() => undefined);
      await writer.end();
      await migrator.end();
    }
  }, 30_000);

  it("the stock_events same-store migration applies and alters the policy in place", async () => {
    await use(APPLY_SCHEMA);
    const rows = await policies(client, APPLY_SCHEMA);
    const isolation = rows.find((row) => row.policyname === "stock_events_isolation");
    const admin = rows.find((row) => row.policyname === "stock_events_platform_admin");
    expect(isolation?.roles).toBe("{app_user}");
    expect(isolation?.cmd).toBe("ALL");
    expect(isolation?.permissive).toBe("PERMISSIVE");
    for (const expression of [isolation?.qual, isolation?.with_check]) {
      expect(expression).toMatch(/store_id = current_setting\('app\.store_id'/);
      expect(expression).toMatch(/EXISTS/);
      expect(expression).toMatch(/listings\.id = stock_events\.listing_id/);
      expect(expression).toMatch(/listings\.store_id = current_setting\('app\.store_id'/);
    }
    expect(admin?.qual).toMatch(/app\.is_platform_admin/);
    expect(admin?.with_check).toMatch(/app\.is_platform_admin/);
    expect(admin?.roles).toBe("{app_user}");
    const flags = await rlsFlags(client, APPLY_SCHEMA);
    expect(flags).toEqual([
      { relname: "listings", relrowsecurity: true, relforcerowsecurity: true },
      { relname: "stock_events", relrowsecurity: true, relforcerowsecurity: true },
    ]);
  });

  it("scratch app_user can write its own event before foreign-parent denial", async () => {
    await use(APPLY_SCHEMA);
    const grants = await client.query<{ usage: boolean; insert: boolean }>(
      `SELECT has_schema_privilege('app_user', $1, 'USAGE') AS usage,
              has_table_privilege('app_user', 'stock_events', 'INSERT') AS insert`,
      [APPLY_SCHEMA],
    );
    expect(grants.rows[0]).toEqual({ usage: true, insert: true });
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE app_user");
    const session = await client.query<{ current_user: string; session_user: string }>(
      "SELECT current_user, session_user",
    );
    expect(session.rows[0].current_user).toBe("app_user");
    expect(session.rows[0].session_user).toBe(role);
    expect(await adminFlag(client)).not.toBe("true");
    await client.query("SELECT set_config('app.store_id', 'sB', true)");
    const inserted = await client.query<{ id: string; tableoid: string }>(
      `INSERT INTO stock_events (id, store_id, listing_id, type, delta, actor_id)
       VALUES ('ev-own', 'sB', 'lB', 'adjust', 6, 'u235')
       RETURNING id, tableoid::text`,
    );
    const placed = await client.query<{ nspname: string }>(
      `SELECT n.nspname
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.oid = $1::oid`,
      [inserted.rows[0].tableoid],
    );
    expect(inserted.rows[0].id).toBe("ev-own");
    expect(placed.rows[0].nspname).toBe(APPLY_SCHEMA);
    await client.query("COMMIT");

    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE app_user");
    await client.query("SELECT set_config('app.store_id', 'sB', true)");
    const foreign = await client.query(
      `INSERT INTO stock_events (id, store_id, listing_id, type, delta, actor_id)
       VALUES ('ev-foreign', 'sB', 'lA', 'adjust', 1, 'u235')`,
    ).then(() => null, (error: unknown) => error);
    expect(pgError(foreign).code).toBe("42501");
    expect(pgError(foreign).message).toContain(RLS_MESSAGE);
    await client.query("ROLLBACK");

    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE app_user");
    await client.query("SELECT set_config('app.store_id', 'sB', true)");
    const missing = await client.query(
      `INSERT INTO stock_events (id, store_id, listing_id, type, delta, actor_id)
       VALUES ('ev-missing', 'sB', 'no-such-listing', 'adjust', 1, 'u235')`,
    ).then(() => null, (error: unknown) => error);
    expect(pgError(missing).code).toBe("42501");
    expect(pgError(missing).message).toContain(RLS_MESSAGE);
    await client.query("ROLLBACK");

    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE app_user");
    await client.query("SELECT set_config('app.store_id', 'sB', true)");
    const own = await client.query<{ id: string; delta: number }>(
      "SELECT id, delta FROM stock_events WHERE id = 'ev-own'",
    );
    expect(own.rows).toEqual([{ id: "ev-own", delta: 6 }]);
    await client.query("COMMIT");
  });

  it("USING hides a mismatched event owned by the current store", async () => {
    await use(APPLY_SCHEMA);
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.is_platform_admin', 'true', true)");
    await client.query(
      `INSERT INTO stock_events (id, store_id, listing_id, type, delta, actor_id)
       VALUES ('ev-hostile', 'sB', 'lA', 'adjust', 11, 'u235')`,
    );
    await client.query("SELECT set_config('app.is_platform_admin', 'false', true)");
    await client.query("COMMIT");
    expect(await adminFlag(client)).not.toBe("true");

    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE app_user");
    await client.query("SELECT set_config('app.store_id', 'sB', true)");
    const visible = await client.query<{ id: string }>("SELECT id FROM stock_events ORDER BY id");
    expect(visible.rows.map((row) => row.id)).not.toContain("ev-hostile");
    expect(visible.rows.map((row) => row.id)).toContain("ev-valid-b");
    const updated = await client.query("UPDATE stock_events SET delta = 99 WHERE id = 'ev-hostile'");
    const deleted = await client.query("DELETE FROM stock_events WHERE id = 'ev-hostile'");
    expect(updated.rowCount).toBe(0);
    expect(deleted.rowCount).toBe(0);
    const changed = await client.query("UPDATE stock_events SET delta = -8 WHERE id = 'ev-valid-b'");
    expect(changed.rowCount).toBe(1);
    const kept = await client.query<{ id: string; delta: number }>(
      "SELECT id, delta FROM stock_events WHERE id = 'ev-valid-b'",
    );
    expect(kept.rows).toEqual([{ id: "ev-valid-b", delta: -8 }]);
    await client.query("COMMIT");

    const hidden = (await eventRows(client)).find((row) => row.id === "ev-hostile");
    expect(hidden).toMatchObject({ store_id: "sB", listing_id: "lA", delta: 11 });
  });

  it("admin event access does not leak into the next scoped transaction", async () => {
    await use(APPLY_SCHEMA);
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.is_platform_admin', 'true', true)");
    const asAdmin = await client.query<{ id: string }>("SELECT id FROM stock_events ORDER BY id");
    expect(asAdmin.rows.map((row) => row.id)).toEqual(
      expect.arrayContaining(["ev-valid-a", "ev-valid-b"]),
    );
    await client.query("COMMIT");

    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE app_user");
    await client.query("SELECT set_config('app.store_id', 'sB', true)");
    expect(await adminFlag(client)).not.toBe("true");
    const asStore = await client.query<{ id: string }>("SELECT id FROM stock_events ORDER BY id");
    expect(asStore.rows.map((row) => row.id)).not.toContain("ev-valid-a");
    expect(asStore.rows.map((row) => row.id)).toContain("ev-valid-b");
    await client.query("COMMIT");

    await client.query("BEGIN");
    await client.query("SELECT set_config('app.is_platform_admin', 'true', true)");
    const failed = await client.query("SELECT 1/0").then(
      () => null,
      (error: unknown) => error,
    );
    expect(failed).toBeTruthy();
    await client.query("ROLLBACK");
    expect(await adminFlag(client)).not.toBe("true");

    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE app_user");
    await client.query("SELECT set_config('app.store_id', 'sB', true)");
    const afterError = await client.query<{ id: string }>("SELECT id FROM stock_events");
    expect(afterError.rows.map((row) => row.id)).not.toContain("ev-valid-a");
    await client.query("COMMIT");
  });
});

describe.skipIf(!connectionString)("stock_events same-store migration on the lane", () => {
  it("live migrated lane has the complete expected RLS policy", async () => {
    const direct = assertSameDatabase(process.env);
    expect(databaseName(direct).startsWith("lane_")).toBe(true);
    const client = new Client({ connectionString: direct });
    await client.connect();
    try {
      const identity = await client.query<{ db: string; usr: string }>(
        "SELECT current_database() AS db, current_user AS usr",
      );
      expect(identity.rows[0].db).toBe(databaseName(direct));
      expect(identity.rows[0].usr).toBe(loginRole(direct));
      const role = await client.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      );
      expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
      const rows = await policies(client, "public");
      const isolation = rows.find((row) => row.policyname === "stock_events_isolation");
      const admin = rows.find((row) => row.policyname === "stock_events_platform_admin");
      expect(isolation?.roles).toBe("{app_user}");
      expect(isolation?.cmd).toBe("ALL");
      expect(isolation?.permissive).toBe("PERMISSIVE");
      for (const expression of [isolation?.qual, isolation?.with_check]) {
        expect(expression ?? "").toMatch(/EXISTS/);
        expect(expression ?? "").toMatch(/stock_events/);
        expect(expression ?? "").toMatch(/listings/);
        expect(expression ?? "").not.toBe("(store_id = current_setting('app.store_id'::text, true))");
      }
      expect(admin?.qual ?? "").toMatch(/is_platform_admin/);
      expect(admin?.with_check ?? "").toMatch(/is_platform_admin/);
      expect(await rlsFlags(client, "public")).toEqual([
        { relname: "listings", relrowsecurity: true, relforcerowsecurity: true },
        { relname: "stock_events", relrowsecurity: true, relforcerowsecurity: true },
      ]);
    } finally {
      await client.end();
    }
  });

  it("migrate diff from the lane database shows no stock_events drift", async () => {
    const direct = assertSameDatabase(process.env);
    const env = { ...process.env, DATABASE_URL: direct, DIRECT_URL: direct };
    delete env.DATABASE_URL_UNPOOLED;
    const { stdout } = await execFileAsync(
      process.execPath,
      [PRISMA_CLI, "migrate", "diff", "--from-config-datasource", "--to-schema", "prisma/schema.prisma", "--script"],
      { cwd: ROOT, env, maxBuffer: 10 * 1024 * 1024 },
    );
    expect(stdout).not.toMatch(/stock_events/);
  }, 60_000);
});

describe.skipIf(!connectionString)("stock_events migration deploy recovery", () => {
  const created: string[] = [];

  afterAll(async () => {
    const direct = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
    if (!direct) return;
    const maintenance = new Client({ connectionString: withDatabase(direct, "postgres") });
    await maintenance.connect();
    try {
      for (const name of created) {
        await maintenance.query(
          "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
          [name],
        );
        await maintenance.query(`DROP DATABASE IF EXISTS ${name}`);
      }
    } finally {
      await maintenance.end();
    }
  });

  it("a fresh empty database applies the stock_events migration and seed", async () => {
    const name = `t235_empty_${Date.now().toString(36)}`;
    created.push(name);
    const direct = assertSameDatabase(process.env);
    await createDatabase(direct, name);
    const env = pinnedEnv(direct, name);
    await expectTarget(env, name);
    await runPrisma(["migrate", "deploy"], env);
    const client = new Client({ connectionString: withDatabase(direct, name) });
    await client.connect();
    try {
      const isolation = (await policies(client, "public")).find((row) => row.policyname === "stock_events_isolation");
      expect(isolation?.qual ?? "").toMatch(/EXISTS/);
      expect(isolation?.with_check ?? "").toMatch(/EXISTS/);
      expect(await rlsFlags(client, "public")).toEqual([
        { relname: "listings", relrowsecurity: true, relforcerowsecurity: true },
        { relname: "stock_events", relrowsecurity: true, relforcerowsecurity: true },
      ]);
    } finally {
      await client.end();
    }
    const seedEnv = {
      ...env,
      SEED_TEST_ADMIN: "1",
      SEED_ADMIN_PASSWORD: env.SEED_ADMIN_PASSWORD ?? "CiTestPass99!",
      SEED_ADMIN_TOTP_SECRET: env.SEED_ADMIN_TOTP_SECRET ?? "JBSWY3DPEHPK3PXP",
      BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET ?? "ci-e2e-test-secret-do-not-use-in-prod",
      NODE_ENV: "test",
    };
    delete seedEnv.SEED_PRUNE_R2;
    delete seedEnv.STOREFRONT_REVALIDATION_URL;
    delete seedEnv.STOREFRONT_REVALIDATION_SECRET;
    delete seedEnv.VITEST;
    await execFileAsync(process.execPath, [TSX_CLI, "prisma/seed.ts"], {
      cwd: ROOT,
      env: seedEnv,
      maxBuffer: 20 * 1024 * 1024,
    });
    const check = new Client({ connectionString: withDatabase(direct, name) });
    await check.connect();
    try {
      const stores = await check.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM stores WHERE slug = 'mama-ngozi'",
      );
      expect(stores.rows[0].n).toBe(1);
    } finally {
      await check.end();
    }
  }, 240_000);

  it("real migrate deploy fails, resolves and successfully retries", async () => {
    const name = `t235_fail_${Date.now().toString(36)}`;
    created.push(name);
    const direct = assertSameDatabase(process.env);
    await createDatabase(direct, name);
    const dbUrl = withDatabase(direct, name);
    const client = new Client({ connectionString: dbUrl });
    await client.connect();
    try {
      const dirs = fs.readdirSync(MIGRATIONS).filter((dir) => /^\d/.test(dir)).sort();
      const prior = dirs.filter((dir) => dir < TARGET);
      for (const dir of prior) {
        await client.query(fs.readFileSync(path.join(MIGRATIONS, dir, "migration.sql"), "utf8"));
      }
      await recordApplied(client, prior);
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.is_platform_admin', 'true', true)");
      await client.query(`
        INSERT INTO stores (id, slug, name, updated_at) VALUES
          ('sA', 'recover-a', 'Recover A', now()),
          ('sB', 'recover-b', 'Recover B', now())
      `);
      await client.query(`
        INSERT INTO users (id, name, email, updated_at)
        VALUES ('u-recover', 'Recover', 'recover-235@example.com', now())
      `);
      await client.query(`
        INSERT INTO listings (id, store_id, price, stock_mode, updated_at) VALUES
          ('lA', 'sA', 100, 'counted', now()),
          ('lB', 'sB', 200, 'counted', now())
      `);
      await client.query(`
        INSERT INTO stock_events (id, store_id, listing_id, type, delta, actor_id) VALUES
          ('ev-keep', 'sA', 'lA', 'recount', 4, 'u-recover'),
          ('ev-bad', 'sB', 'lA', 'adjust', 1, 'u-recover')
      `);
      await client.query("SELECT set_config('app.is_platform_admin', 'false', true)");
      await client.query("COMMIT");
      const beforePolicy = await policies(client, "public");
      const beforeEvents = await eventRows(client);
      const env = pinnedEnv(direct, name);
      await expectTarget(env, name);
      const failed = await runPrisma(["migrate", "deploy"], env).then(
        () => null,
        (error: unknown) => error,
      );
      expect(pgError(failed).message).toMatch(
        /stock_events rows reference a listing in another store: 1/,
      );
      expect(await policies(client, "public")).toEqual(beforePolicy);
      expect(await eventRows(client)).toEqual(beforeEvents);
      expect(await adminFlag(client)).not.toBe("true");
      const failedRows = await client.query<{ finished: boolean; rolled: boolean; logs: string | null }>(
        `SELECT finished_at IS NOT NULL AS finished,
                rolled_back_at IS NOT NULL AS rolled,
                logs
         FROM "_prisma_migrations"
         WHERE migration_name = $1`,
        [TARGET],
      );
      expect(failedRows.rows).toHaveLength(1);
      expect(failedRows.rows[0].finished).toBe(false);
      expect(failedRows.rows[0].rolled).toBe(false);
      expect(failedRows.rows[0].logs ?? "").toMatch(/another store: 1/);

      await client.query("BEGIN");
      await client.query("SELECT set_config('app.is_platform_admin', 'true', true)");
      await client.query("DELETE FROM stock_events WHERE id = 'ev-bad'");
      await client.query("SELECT set_config('app.is_platform_admin', 'false', true)");
      await client.query("COMMIT");
      await runPrisma(["migrate", "resolve", "--rolled-back", TARGET], env);
      const resolved = await client.query<{ finished: boolean; rolled: boolean }>(
        `SELECT finished_at IS NOT NULL AS finished, rolled_back_at IS NOT NULL AS rolled
         FROM "_prisma_migrations" WHERE migration_name = $1`,
        [TARGET],
      );
      expect(resolved.rows).toEqual([{ finished: false, rolled: true }]);
      await runPrisma(["migrate", "deploy"], env);
      const isolation = (await policies(client, "public")).find((row) => row.policyname === "stock_events_isolation");
      expect(isolation?.qual ?? "").toMatch(/EXISTS/);
      expect(isolation?.with_check ?? "").toMatch(/EXISTS/);
      const kept = (await eventRows(client)).find((row) => row.id === "ev-keep");
      expect(kept).toMatchObject({ store_id: "sA", listing_id: "lA", type: "recount", delta: 4, actor_id: "u-recover" });
      expect((await eventRows(client)).some((row) => row.id === "ev-bad")).toBe(false);
      const applied = await client.query<{ finished: boolean; open: number }>(
        `SELECT bool_or(finished_at IS NOT NULL) AS finished,
                count(*) FILTER (WHERE finished_at IS NULL AND rolled_back_at IS NULL)::int AS open
         FROM "_prisma_migrations" WHERE migration_name = $1`,
        [TARGET],
      );
      expect(applied.rows[0]).toEqual({ finished: true, open: 0 });
    } finally {
      await client.end();
    }
  }, 180_000);
});

async function replay(client: Client, schema: string, throughTarget: boolean) {
  assertSchema(schema);
  await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await client.query(`CREATE SCHEMA ${schema}`);
  await client.query(`SET search_path = ${schema}, public`);
  const dirs = fs.readdirSync(MIGRATIONS).filter((dir) => /^\d/.test(dir)).sort();
  for (const dir of dirs) {
    if (!throughTarget && dir === TARGET) break;
    await client.query(fs.readFileSync(path.join(MIGRATIONS, dir, "migration.sql"), "utf8"));
  }
  await client.query(`GRANT USAGE ON SCHEMA ${schema} TO app_user`);
  await client.query(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schema} TO app_user`,
  );
  await client.query(`SET search_path = ${schema}`);
}

async function seedHistory(client: Client, withMismatches: boolean) {
  await client.query("BEGIN");
  await client.query("SELECT set_config('app.is_platform_admin', 'true', true)");
  await client.query(`
    INSERT INTO stores (id, slug, name, updated_at) VALUES
      ('sA', 'sa', 'Store A', now()),
      ('sB', 'sb', 'Store B', now()),
      ('sC', 'sc', 'Store C', now())
  `);
  await client.query(`
    INSERT INTO users (id, name, email, updated_at)
    VALUES ('u235', 'Actor', 'stock-events-235@example.com', now())
  `);
  await client.query(`
    INSERT INTO listings (id, store_id, price, stock_mode, updated_at) VALUES
      ('lA', 'sA', 100, 'counted', now()),
      ('lB', 'sB', 200, 'counted', now()),
      ('lC', 'sC', 300, 'counted', now())
  `);
  await client.query(`
    INSERT INTO stock_events (id, store_id, listing_id, type, delta, actor_id, created_at) VALUES
      ('ev-valid-a', 'sA', 'lA', 'recount', 4, 'u235', timestamp '2026-01-15 12:00:00'),
      ('ev-valid-b', 'sB', 'lB', 'adjust', -2, 'u235', timestamp '2026-01-15 12:00:01')
  `);
  if (withMismatches) {
    await client.query(`
      INSERT INTO stock_events (id, store_id, listing_id, type, delta, actor_id, created_at) VALUES
        ('ev-bad-1', 'sB', 'lA', 'adjust', 1, 'u235', timestamp '2026-01-15 12:00:02'),
        ('ev-bad-2', 'sC', 'lA', 'adjust', 2, 'u235', timestamp '2026-01-15 12:00:03'),
        ('ev-bad-3', 'sA', 'lB', 'recount', 9, 'u235', timestamp '2026-01-15 12:00:04')
    `);
  }
  await client.query("SELECT set_config('app.is_platform_admin', 'false', true)");
  await client.query("COMMIT");
}

async function policies(client: Client, schema: string): Promise<PolicyRow[]> {
  const { rows } = await client.query<PolicyRow>(
    `SELECT policyname, permissive, roles::text AS roles, cmd, qual, with_check
     FROM pg_policies
     WHERE schemaname = $1 AND tablename = 'stock_events'
     ORDER BY policyname`,
    [schema],
  );
  return rows;
}

async function eventRows(client: Client): Promise<EventRow[]> {
  await client.query("BEGIN");
  await client.query("SELECT set_config('app.is_platform_admin', 'true', true)");
  const { rows } = await client.query<EventRow>(`
    SELECT id, store_id, listing_id, type, delta, actor_id, created_at::text AS created_at
    FROM stock_events
    ORDER BY id
  `);
  await client.query("SELECT set_config('app.is_platform_admin', 'false', true)");
  await client.query("COMMIT");
  return rows;
}

async function adminFlag(client: Client): Promise<string | null> {
  const { rows } = await client.query<{ value: string | null }>(
    "SELECT current_setting('app.is_platform_admin', true) AS value",
  );
  return rows[0].value;
}

async function rlsFlags(client: Client, schema: string) {
  const { rows } = await client.query<{
    relname: string;
    relrowsecurity: boolean;
    relforcerowsecurity: boolean;
  }>(
    `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relname IN ('listings', 'stock_events')
     ORDER BY c.relname`,
    [schema],
  );
  return rows;
}

async function expectForcedOwner(client: Client, schema: string, role: string) {
  const identity = await client.query<{ current_user: string; session_user: string }>(
    "SELECT current_user, session_user",
  );
  expect(identity.rows[0]).toEqual({ current_user: role, session_user: role });
  const privileges = await client.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
    "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
  );
  expect(privileges.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  expect(await adminFlag(client)).not.toBe("true");
  expect(await rlsFlags(client, schema)).toEqual([
    { relname: "listings", relrowsecurity: true, relforcerowsecurity: true },
    { relname: "stock_events", relrowsecurity: true, relforcerowsecurity: true },
  ]);
}

async function connectSchema(schema: string): Promise<Client> {
  assertSchema(schema);
  const extra = new Client({ connectionString });
  await extra.connect();
  await extra.query(`SET search_path = ${schema}`);
  return extra;
}

async function backendPid(client: Client): Promise<number> {
  const { rows } = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
  return rows[0].pid;
}

async function waitForLockWait(observer: Client, pid: number) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const { rows } = await observer.query(
      "SELECT 1 FROM pg_locks WHERE pid = $1 AND NOT granted LIMIT 1",
      [pid],
    );
    if (rows.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("the overlapping statement never waited on a lock");
}

async function createDatabase(direct: string, name: string) {
  const maintenance = new Client({ connectionString: withDatabase(direct, "postgres") });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE ${name}`);
  } finally {
    await maintenance.end();
  }
}

function pinnedEnv(direct: string, database: string): NodeJS.ProcessEnv {
  const url = withDatabase(direct, database);
  const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: url, DIRECT_URL: url };
  delete env.DATABASE_URL_UNPOOLED;
  delete env.SEED_PRUNE_R2;
  return env;
}

async function expectTarget(env: NodeJS.ProcessEnv, database: string) {
  const { stdout } = await execFileAsync(
    process.execPath,
    [TSX_CLI, "-e", "import { resolveDirectUrl } from './src/lib/env.ts'; const name = new URL(resolveDirectUrl()).pathname.replace(/^\\//, ''); if (name !== process.env.EXPECTED_DB) { console.error('target ' + name); process.exit(1); } console.log('ok');"],
    { cwd: ROOT, env: { ...env, EXPECTED_DB: database }, maxBuffer: 1024 * 1024 },
  );
  expect(stdout.trim()).toBe("ok");
}

async function runPrisma(args: string[], env: NodeJS.ProcessEnv) {
  try {
    return await execFileAsync(process.execPath, [PRISMA_CLI, ...args], {
      cwd: ROOT,
      env,
      maxBuffer: 20 * 1024 * 1024,
    });
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string; message?: string };
    const wrapped = new Error(redact(`${failed.stdout ?? ""}\n${failed.stderr ?? ""}\n${failed.message ?? ""}`));
    throw wrapped;
  }
}

async function recordApplied(client: Client, dirs: string[]) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
      id VARCHAR(36) PRIMARY KEY NOT NULL,
      checksum VARCHAR(64) NOT NULL,
      finished_at TIMESTAMPTZ,
      migration_name VARCHAR(255) NOT NULL,
      logs TEXT,
      rolled_back_at TIMESTAMPTZ,
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      applied_steps_count INTEGER NOT NULL DEFAULT 0
    )
  `);
  for (const dir of dirs) {
    const checksum = createHash("sha256")
      .update(fs.readFileSync(path.join(MIGRATIONS, dir, "migration.sql")))
      .digest("hex");
    await client.query(
      `INSERT INTO "_prisma_migrations" (id, checksum, finished_at, migration_name, applied_steps_count)
       VALUES ($1, $2, now(), $3, 1)`,
      [randomUUID(), checksum, dir],
    );
  }
}
