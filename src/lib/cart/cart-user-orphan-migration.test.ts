import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { resolveDirectUrl } from "../env";

// FORCE ROW LEVEL SECURITY applies to the table owner unless that role is a
// superuser or has BYPASSRLS. This replay keeps RLS enabled and forced on
// carts and customers. It never disables RLS and never reads through a
// bypassing role. Visibility for assertions is SET LOCAL ROLE app_user plus
// app.is_platform_admin, inside a transaction that ends before the next one.

const MIGRATIONS = path.resolve(__dirname, "../../../prisma/migrations");
const OLD_MIGRATION = "20261104180000_cart_user_fk_and_customer_notes";
const CLEANUP_MARKER = "clear_orphan_cart_user_ids";
const REPLAY_LOCK = 199031030;
const STAMP = "2026-01-15 12:00:00.000";

const ci = typeof process.env.CI === "string" && process.env.CI.length > 0;

let directUrl: string | undefined;
try {
  const resolved = resolveDirectUrl();
  directUrl = resolved.length > 0 ? resolved : undefined;
} catch {
  directUrl = undefined;
}

it("has a database connection in CI", () => {
  if (!ci) return;
  expect(directUrl, "resolveDirectUrl() must succeed in CI").toBeTruthy();
});

it("CI requires a usable direct migration endpoint", () => {
  if (!ci) return;
  const url = resolveDirectUrl();
  expect(url.length).toBeGreaterThan(0);
});

type CartRow = {
  id: string;
  store_id: string;
  user_id: string | null;
  customer_id: string | null;
  payment_intent_id: string | null;
  source: string;
  created_at: string;
  updated_at: string;
};

type LineRow = {
  id: string;
  store_id: string;
  cart_id: string;
  variant_id: string;
  qty: number;
  swap_rule: string;
  substitute_variant_id: string | null;
  created_at: string;
  updated_at: string;
};

type PolicyRow = {
  polname: string;
  using_expr: string | null;
  check_expr: string | null;
  polcmd: string;
};

const CARTS_BEFORE: CartRow[] = [
  {
    id: "cart-case",
    store_id: "store-a",
    user_id: "U1",
    customer_id: null,
    payment_intent_id: "pi-case",
    source: "reorder",
    created_at: STAMP,
    updated_at: STAMP,
  },
  {
    id: "cart-empty",
    store_id: "store-a",
    user_id: "",
    customer_id: null,
    payment_intent_id: "pi-empty",
    source: "reorder",
    created_at: STAMP,
    updated_at: STAMP,
  },
  {
    id: "cart-guest",
    store_id: "store-a",
    user_id: null,
    customer_id: "cust-guest",
    payment_intent_id: "pi-guest",
    source: "guest",
    created_at: STAMP,
    updated_at: STAMP,
  },
  {
    id: "cart-linked",
    store_id: "store-a",
    user_id: "u1",
    customer_id: "cust-linked",
    payment_intent_id: "pi-linked",
    source: "staff",
    created_at: STAMP,
    updated_at: STAMP,
  },
  {
    id: "cart-orphan-a",
    store_id: "store-a",
    user_id: "missing",
    customer_id: "cust-orphan",
    payment_intent_id: "pi-orphan-a",
    source: "reorder",
    created_at: STAMP,
    updated_at: STAMP,
  },
  {
    id: "cart-orphan-b",
    store_id: "store-b",
    user_id: "gone",
    customer_id: "cust-b",
    payment_intent_id: "pi-orphan-b",
    source: "reorder",
    created_at: STAMP,
    updated_at: STAMP,
  },
];

const CARTS_AFTER: CartRow[] = [
  { ...CARTS_BEFORE[0]!, user_id: null },
  { ...CARTS_BEFORE[1]!, user_id: null },
  CARTS_BEFORE[2]!,
  CARTS_BEFORE[3]!,
  { ...CARTS_BEFORE[4]!, user_id: null },
  { ...CARTS_BEFORE[5]!, user_id: null },
];

const LINES: LineRow[] = [
  {
    id: "line-guest",
    store_id: "store-a",
    cart_id: "cart-guest",
    variant_id: "variant-a",
    qty: 1,
    swap_rule: "exact_only",
    substitute_variant_id: null,
    created_at: STAMP,
    updated_at: STAMP,
  },
  {
    id: "line-linked",
    store_id: "store-a",
    cart_id: "cart-linked",
    variant_id: "variant-a",
    qty: 2,
    swap_rule: "exact_only",
    substitute_variant_id: null,
    created_at: STAMP,
    updated_at: STAMP,
  },
  {
    id: "line-orphan-a",
    store_id: "store-a",
    cart_id: "cart-orphan-a",
    variant_id: "variant-a",
    qty: 3,
    swap_rule: "store_suggests",
    substitute_variant_id: "variant-a2",
    created_at: STAMP,
    updated_at: STAMP,
  },
];

function qi(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) {
    throw new Error(`refusing unsafe SQL identifier: ${name}`);
  }
  return `"${name}"`;
}

function settingCleared(value: string | null): boolean {
  return value == null || value === "";
}

function cleanupSqlText(): string | undefined {
  const dirs = fs.readdirSync(MIGRATIONS).filter((dir) => dir.includes(CLEANUP_MARKER));
  if (dirs.length > 1) {
    throw new Error(`expected one ${CLEANUP_MARKER} migration, found ${dirs.join(", ")}`);
  }
  if (dirs.length === 0) return undefined;
  return fs.readFileSync(path.join(MIGRATIONS, dirs[0]!, "migration.sql"), "utf8");
}

function migrationDirsBeforeOld(): string[] {
  return fs
    .readdirSync(MIGRATIONS)
    .filter((dir) => /^\d/.test(dir))
    .sort()
    .filter((dir) => dir < OLD_MIGRATION && !dir.includes(CLEANUP_MARKER));
}

async function replayBeforeOld(db: Client, schemaName: string): Promise<void> {
  const quoted = qi(schemaName);
  await db.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`);
  await db.query(`CREATE SCHEMA ${quoted}`);
  await db.query(`GRANT USAGE ON SCHEMA ${quoted} TO app_user`);
  await db.query(`SET search_path = ${quoted}, public`);
  for (const dir of migrationDirsBeforeOld()) {
    const sql = fs.readFileSync(path.join(MIGRATIONS, dir, "migration.sql"), "utf8");
    await db.query(sql);
  }
}

function seedSql(schemaName: string): string {
  const s = qi(schemaName);
  const ts = `TIMESTAMP '${STAMP}'`;
  return `
    INSERT INTO ${s}.stores (id, slug, name, updated_at)
    VALUES ('store-a', 'store-a', 'Store A', ${ts}),
           ('store-b', 'store-b', 'Store B', ${ts});
    INSERT INTO ${s}.users (id, name, email, updated_at)
    VALUES ('u1', 'Ada Account', 'ada-account@example.com', ${ts});
    INSERT INTO ${s}.listings (id, store_id, price, stock_mode, updated_at)
    VALUES ('listing-a', 'store-a', 1500, 'unlimited', ${ts}),
           ('listing-b', 'store-b', 900, 'unlimited', ${ts});
    INSERT INTO ${s}.listing_variants (id, listing_id, label, price, weight_g, updated_at)
    VALUES ('variant-a', 'listing-a', '500g', 1500, 500, ${ts}),
           ('variant-a2', 'listing-a', '1kg', 2500, 1000, ${ts}),
           ('variant-b', 'listing-b', '250g', 900, 250, ${ts});
    INSERT INTO ${s}.customers (id, store_id, user_id, name, email, updated_at)
    VALUES ('cust-orphan', 'store-a', NULL, 'Orphan cart customer', 'orphan@example.com', ${ts}),
           ('cust-linked', 'store-a', 'u1', 'Ada Account', 'ada-account@example.com', ${ts}),
           ('cust-guest', 'store-a', NULL, 'Guest', 'guest@example.com', ${ts}),
           ('cust-b', 'store-b', NULL, 'Other store customer', 'other@example.com', ${ts});
    INSERT INTO ${s}.carts (
      id, store_id, user_id, customer_id, payment_intent_id, source, created_at, updated_at
    ) VALUES
      ('cart-case', 'store-a', 'U1', NULL, 'pi-case', 'reorder', ${ts}, ${ts}),
      ('cart-empty', 'store-a', '', NULL, 'pi-empty', 'reorder', ${ts}, ${ts}),
      ('cart-guest', 'store-a', NULL, 'cust-guest', 'pi-guest', 'guest', ${ts}, ${ts}),
      ('cart-linked', 'store-a', 'u1', 'cust-linked', 'pi-linked', 'staff', ${ts}, ${ts}),
      ('cart-orphan-a', 'store-a', 'missing', 'cust-orphan', 'pi-orphan-a', 'reorder', ${ts}, ${ts}),
      ('cart-orphan-b', 'store-b', 'gone', 'cust-b', 'pi-orphan-b', 'reorder', ${ts}, ${ts});
    INSERT INTO ${s}.cart_lines (
      id, store_id, cart_id, variant_id, qty, swap_rule, substitute_variant_id, created_at, updated_at
    ) VALUES
      ('line-guest', 'store-a', 'cart-guest', 'variant-a', 1, 'exact_only', NULL, ${ts}, ${ts}),
      ('line-linked', 'store-a', 'cart-linked', 'variant-a', 2, 'exact_only', NULL, ${ts}, ${ts}),
      ('line-orphan-a', 'store-a', 'cart-orphan-a', 'variant-a', 3, 'store_suggests', 'variant-a2', ${ts}, ${ts});
  `;
}

async function seedAsAdmin(db: Client, schemaName: string, sql: string): Promise<void> {
  await db.query("BEGIN");
  try {
    await db.query("SELECT set_config('app.is_platform_admin', 'true', true)");
    await db.query(sql);
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }
}

async function rollbackQuietly(db: Client): Promise<void> {
  try {
    await db.query("ROLLBACK");
  } catch {
    // No open transaction, or the connection is already closing.
  }
}

describe.skipIf(!directUrl)("cart account orphan migration", () => {
  const schemaName = `tmp_co242_${process.pid}`;
  const quoted = qi(schemaName);
  let client: Client | undefined;
  let locked = false;
  let cleanupApplied = false;
  let emptyCleanup: { ran: boolean; before: number; after: number } = {
    ran: false,
    before: -1,
    after: -1,
  };
  let policiesBefore: { carts: PolicyRow[]; customers: PolicyRow[] } | undefined;
  let serverVersion = "";
  let ctidBefore: Record<string, string> = {};

  async function withAuthorized<T>(fn: (db: Client) => Promise<T>): Promise<T> {
    const db = client!;
    await db.query("BEGIN");
    try {
      await db.query("SET LOCAL ROLE app_user");
      await db.query("SELECT set_config('app.is_platform_admin', 'true', true)");
      return await fn(db);
    } finally {
      await rollbackQuietly(db);
    }
  }

  async function readSnapshot(db: Client): Promise<{ carts: CartRow[]; lines: LineRow[] }> {
    const carts = await db.query<CartRow>(
      `SELECT id, store_id, user_id, customer_id, payment_intent_id, source,
              to_char(created_at, 'YYYY-MM-DD HH24:MI:SS.MS') AS created_at,
              to_char(updated_at, 'YYYY-MM-DD HH24:MI:SS.MS') AS updated_at
       FROM ${quoted}.carts
       ORDER BY id`,
    );
    const lines = await db.query<LineRow>(
      `SELECT id, store_id, cart_id, variant_id, qty, swap_rule, substitute_variant_id,
              to_char(created_at, 'YYYY-MM-DD HH24:MI:SS.MS') AS created_at,
              to_char(updated_at, 'YYYY-MM-DD HH24:MI:SS.MS') AS updated_at
       FROM ${quoted}.cart_lines
       ORDER BY id`,
    );
    return { carts: carts.rows, lines: lines.rows };
  }

  async function applyCleanup(): Promise<void> {
    if (cleanupApplied) return;
    const sql = cleanupSqlText();
    if (sql) await client!.query(sql);
    cleanupApplied = true;
  }

  beforeAll(async () => {
    client = new Client({ connectionString: directUrl });
    await client.connect();
    await client.query("SELECT pg_advisory_lock($1)", [REPLAY_LOCK]);
    locked = true;
    try {
      await replayBeforeOld(client, schemaName);
      const version = await client.query<{ version: string }>("SELECT version() AS version");
      serverVersion = version.rows[0]?.version ?? "";

      const sql = cleanupSqlText();
      if (sql) {
        const before = await client.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM ${quoted}.carts`,
        );
        await client.query(sql);
        const after = await client.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM ${quoted}.carts`,
        );
        emptyCleanup = { ran: true, before: before.rows[0]!.n, after: after.rows[0]!.n };
      }

      await seedAsAdmin(client, schemaName, seedSql(schemaName));
      const oldSql = fs.readFileSync(path.join(MIGRATIONS, OLD_MIGRATION, "migration.sql"), "utf8");
      await client.query(oldSql);
      await client.query("BEGIN");
      try {
        await client.query("SELECT set_config('app.is_platform_admin', 'true', true)");
        const ctids = await client.query<{ id: string; ctid: string }>(
          `SELECT id, ctid::text AS ctid FROM ${quoted}.carts`,
        );
        ctidBefore = Object.fromEntries(ctids.rows.map((row) => [row.id, row.ctid]));
        await client.query("ROLLBACK");
      } catch (error) {
        await rollbackQuietly(client);
        throw error;
      }

      policiesBefore = {
        carts: (
          await client.query<PolicyRow>(
            `SELECT pol.polname, pg_get_expr(pol.polqual, pol.polrelid) AS using_expr,
                    pg_get_expr(pol.polwithcheck, pol.polrelid) AS check_expr, pol.polcmd
             FROM pg_policy pol
             WHERE pol.polrelid = to_regclass($1)
             ORDER BY pol.polname`,
            [`${schemaName}.carts`],
          )
        ).rows,
        customers: (
          await client.query<PolicyRow>(
            `SELECT pol.polname, pg_get_expr(pol.polqual, pol.polrelid) AS using_expr,
                    pg_get_expr(pol.polwithcheck, pol.polrelid) AS check_expr, pol.polcmd
             FROM pg_policy pol
             WHERE pol.polrelid = to_regclass($1)
             ORDER BY pol.polname`,
            [`${schemaName}.customers`],
          )
        ).rows,
      };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    }
  }, 180_000);

  afterAll(async () => {
    const db = client;
    if (!db) return;
    await rollbackQuietly(db);
    try {
      await db.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`);
    } catch {
      // E27: still release the advisory lock and close the connection.
    }
    try {
      if (locked) await db.query("SELECT pg_advisory_unlock($1)", [REPLAY_LOCK]);
    } finally {
      locked = false;
      await db.end().catch(() => undefined);
    }
  }, 30_000);

  it("replays as a role that row-level security applies to", async () => {
    const role = await client!.query<{
      current_user: string;
      session_user: string;
      rolsuper: boolean;
      rolbypassrls: boolean;
      usage: boolean;
    }>(
      `SELECT current_user,
              session_user::text AS session_user,
              r.rolsuper,
              r.rolbypassrls,
              pg_has_role(current_user, 'app_user', 'USAGE') AS usage
       FROM pg_roles r
       WHERE r.rolname = current_user`,
    );
    expect(role.rows[0]).toMatchObject({
      rolsuper: false,
      rolbypassrls: false,
      usage: true,
    });
    expect(role.rows[0]?.current_user).toBe(role.rows[0]?.session_user);
    expect(serverVersion).toMatch(/PostgreSQL/);
  });

  it("migration owner has effective policy privileges and forced RLS stays active", async () => {
    const usage = await client!.query<{ ok: boolean }>(
      `SELECT has_schema_privilege('app_user', $1, 'USAGE') AS ok`,
      [schemaName],
    );
    expect(usage.rows[0]?.ok).toBe(true);
    for (const table of ["carts", "customers"]) {
      const rel = await client!.query<{
        nspname: string;
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
        owner: string;
        row_security_active: boolean;
        owner_update: boolean;
        app_user_update: boolean;
      }>(
        `SELECT n.nspname,
                c.relrowsecurity,
                c.relforcerowsecurity,
                pg_get_userbyid(c.relowner) AS owner,
                row_security_active(c.oid) AS row_security_active,
                has_table_privilege(current_user, c.oid, 'UPDATE') AS owner_update,
                has_table_privilege('app_user', c.oid, 'UPDATE') AS app_user_update
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE c.oid = to_regclass($1)`,
        [`${schemaName}.${table}`],
      );
      expect(rel.rows[0], table).toMatchObject({
        nspname: schemaName,
        relrowsecurity: true,
        relforcerowsecurity: true,
        row_security_active: true,
        owner_update: true,
        app_user_update: true,
      });
      expect(rel.rows[0]?.owner).toBe(
        (
          await client!.query<{ current_user: string }>("SELECT current_user")
        ).rows[0]?.current_user,
      );
    }
    await client!.query("BEGIN");
    try {
      const hidden = await client!.query<{ admin: string | null; store: string | null; n: number }>(
        `SELECT current_setting('app.is_platform_admin', true) AS admin,
                current_setting('app.store_id', true) AS store,
                (SELECT count(*)::int FROM ${quoted}.carts) AS n`,
      );
      expect(settingCleared(hidden.rows[0]?.admin ?? null)).toBe(true);
      expect(settingCleared(hidden.rows[0]?.store ?? null)).toBe(true);
      expect(hidden.rows[0]?.n).toBe(0);
      await client!.query("SELECT set_config('app.is_platform_admin', 'true', true)");
      const shown = await client!.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM ${quoted}.carts`,
      );
      expect(shown.rows[0]?.n).toBe(CARTS_BEFORE.length);
    } finally {
      await rollbackQuietly(client!);
    }
  });

  it("authorized assertions resolve the scratch relations under app_user", async () => {
    const resolved = await withAuthorized(async (db) => {
      const carts = await db.query<{
        oid: string;
        nspname: string;
        reg: string | null;
        public_oid: string | null;
      }>(
        `SELECT c.oid::text AS oid,
                n.nspname,
                to_regclass($1)::text AS reg,
                to_regclass('public.carts')::oid::text AS public_oid
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE c.oid = to_regclass($1)`,
        [`${schemaName}.carts`],
      );
      const customers = await db.query<{ nspname: string }>(
        `SELECT n.nspname
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE c.oid = to_regclass($1)`,
        [`${schemaName}.customers`],
      );
      const fk = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n
         FROM pg_constraint
         WHERE conname = 'carts_user_id_fkey'
           AND conrelid = $1::oid`,
        [carts.rows[0]?.oid],
      );
      return { carts: carts.rows[0], customers: customers.rows[0], fk: fk.rows[0]?.n };
    });
    expect(resolved.carts?.nspname).toBe(schemaName);
    expect(resolved.carts?.oid).toBeTruthy();
    expect(resolved.carts?.public_oid).toBeTruthy();
    expect(resolved.carts?.oid).not.toBe(resolved.carts?.public_oid);
    expect(resolved.customers?.nspname).toBe(schemaName);
    expect(resolved.fk).toBe(1);
  });

  it("20261104180000 leaves the orphan account id under forced RLS", async () => {
    const snap = await withAuthorized((db) => readSnapshot(db));
    const fk = await client!.query<{ convalidated: boolean; oid: string }>(
      `SELECT c.convalidated, c.conrelid::text AS oid
       FROM pg_constraint c
       WHERE c.conname = 'carts_user_id_fkey'
         AND c.conrelid = to_regclass($1)`,
      [`${schemaName}.carts`],
    );
    const evidence = `server ${serverVersion} carts oid ${fk.rows[0]?.oid ?? "missing"}`;
    expect(snap.carts, evidence).toEqual(CARTS_BEFORE);
    expect(snap.lines, evidence).toEqual(LINES);
    expect(fk.rows, evidence).toEqual([{ convalidated: true, oid: expect.any(String) }]);
    console.log(`cart-orphan-replay ${evidence} convalidated=true orphan=missing`);
  });

  it("failed cleanup rolls back data and local authorization", async () => {
    const sql = cleanupSqlText();
    expect(sql, "cleanup migration file").toBeTruthy();
    await client!.query("BEGIN");
    try {
      await client!.query(`
        CREATE FUNCTION ${quoted}.fail_orphan_clear() RETURNS trigger
        LANGUAGE plpgsql AS $fn$
        BEGIN
          IF OLD.user_id IS NOT NULL AND NEW.user_id IS NULL THEN
            RAISE EXCEPTION 'forced cleanup failure';
          END IF;
          RETURN NEW;
        END
        $fn$
      `);
      await client!.query(`
        CREATE TRIGGER fail_orphan_clear
        BEFORE UPDATE ON ${quoted}.carts
        FOR EACH ROW EXECUTE FUNCTION ${quoted}.fail_orphan_clear()
      `);
      let failed = false;
      try {
        await client!.query(sql!);
      } catch (error) {
        failed = /forced cleanup failure/.test(String(error));
      }
      expect(failed).toBe(true);
    } finally {
      await rollbackQuietly(client!);
    }
    const snap = await withAuthorized((db) => readSnapshot(db));
    expect(snap.carts).toEqual(CARTS_BEFORE);
    expect(snap.lines).toEqual(LINES);
    const setting = await client!.query<{ admin: string | null }>(
      `SELECT current_setting('app.is_platform_admin', true) AS admin`,
    );
    expect(settingCleared(setting.rows[0]?.admin ?? null)).toBe(true);
  });

  it("a statement error rolls back and the advisory lock stays held", async () => {
    await client!.query("BEGIN");
    let failed = false;
    try {
      await client!.query("SELECT definitely_missing_column");
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
    await rollbackQuietly(client!);
    const ok = await client!.query<{ n: number }>("SELECT 1::int AS n");
    expect(ok.rows[0]?.n).toBe(1);
    const lock = await client!.query<{ granted: boolean }>(
      `SELECT granted
       FROM pg_locks
       WHERE locktype = 'advisory'
         AND pid = pg_backend_pid()
         AND classid = ($1::bigint >> 32)::integer
         AND objid = ($1::bigint & 4294967295)::integer
         AND objsubid = 1`,
      [REPLAY_LOCK],
    );
    expect(lock.rows[0]?.granted).toBe(true);
  });

  it("cleanup enables its own visibility after inspection transactions end", async () => {
    await client!.query("BEGIN");
    try {
      const hidden = await client!.query<{ admin: string | null; store: string | null; n: number }>(
        `SELECT current_setting('app.is_platform_admin', true) AS admin,
                current_setting('app.store_id', true) AS store,
                (SELECT count(*)::int FROM ${quoted}.carts) AS n`,
      );
      expect(settingCleared(hidden.rows[0]?.admin ?? null)).toBe(true);
      expect(settingCleared(hidden.rows[0]?.store ?? null)).toBe(true);
      expect(hidden.rows[0]?.n, "unscoped read must see zero carts before cleanup").toBe(0);
    } finally {
      await rollbackQuietly(client!);
    }
    await applyCleanup();
  });

  it("the cleanup migration clears orphan account ids in every store and keeps linked and guest carts", async () => {
    await applyCleanup();
    const snap = await withAuthorized((db) => readSnapshot(db));
    expect(snap.carts).toEqual(CARTS_AFTER);
    expect(snap.carts).toHaveLength(CARTS_BEFORE.length);
  });

  it("cleanup preserves complete carts and nonempty cart lines", async () => {
    await applyCleanup();
    const snap = await withAuthorized((db) => readSnapshot(db));
    expect(snap.carts).toEqual(CARTS_AFTER);
    expect(snap.lines).toEqual(LINES);
    expect(snap.lines.length).toBeGreaterThan(0);
    const ctids = await withAuthorized(async (db) => {
      const rows = await db.query<{ id: string; ctid: string }>(
        `SELECT id, ctid::text AS ctid FROM ${quoted}.carts`,
      );
      return Object.fromEntries(rows.rows.map((row) => [row.id, row.ctid]));
    });
    expect(ctids["cart-guest"]).toBe(ctidBefore["cart-guest"]);
    expect(ctids["cart-linked"]).toBe(ctidBefore["cart-linked"]);
    expect(ctids["cart-orphan-a"]).not.toBe(ctidBefore["cart-orphan-a"]);
    expect(ctids["cart-orphan-b"]).not.toBe(ctidBefore["cart-orphan-b"]);
  });

  it("the cleanup migration leaves app.is_platform_admin cleared", async () => {
    const sql = cleanupSqlText();
    expect(sql).toBeTruthy();
    await client!.query("BEGIN");
    try {
      await client!.query(sql!);
      const inside = await client!.query<{ admin: string | null }>(
        `SELECT current_setting('app.is_platform_admin', true) AS admin`,
      );
      expect(inside.rows[0]?.admin).not.toBe("true");
      expect(settingCleared(inside.rows[0]?.admin ?? null)).toBe(true);
      await client!.query("COMMIT");
    } catch (error) {
      await rollbackQuietly(client!);
      throw error;
    }
  });

  it("cleanup clears elevation inside the transaction and after commit", async () => {
    const sql = cleanupSqlText();
    expect(sql).toBeTruthy();
    await client!.query("BEGIN");
    try {
      await client!.query(sql!);
      const inside = await client!.query<{ admin: string | null }>(
        `SELECT current_setting('app.is_platform_admin', true) AS admin`,
      );
      expect(settingCleared(inside.rows[0]?.admin ?? null)).toBe(true);
      await client!.query("COMMIT");
    } catch (error) {
      await rollbackQuietly(client!);
      throw error;
    }
    const after = await client!.query<{ admin: string | null }>(
      `SELECT current_setting('app.is_platform_admin', true) AS admin`,
    );
    expect(settingCleared(after.rows[0]?.admin ?? null)).toBe(true);

    await client!.query("BEGIN");
    try {
      await client!.query("SET LOCAL ROLE app_user");
      await client!.query("SELECT set_config('app.store_id', 'store-a', true)");
      const hidden = await client!.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM ${quoted}.carts WHERE id = 'cart-orphan-b'`,
      );
      expect(hidden.rows[0]?.n).toBe(0);
      let rejected = false;
      try {
        await client!.query(
          `INSERT INTO ${quoted}.carts (id, store_id, source, created_at, updated_at)
           VALUES ('cart-cross', 'store-b', 'manual', TIMESTAMP '${STAMP}', TIMESTAMP '${STAMP}')`,
        );
      } catch (error) {
        const coded = error as { code?: string; message?: string };
        rejected =
          coded.code === "42501" && /row-level security/i.test(coded.message ?? String(error));
      }
      expect(rejected).toBe(true);
    } finally {
      await rollbackQuietly(client!);
    }

    for (const table of ["carts", "customers"]) {
      const rel = await client!.query<{ relforcerowsecurity: boolean; relrowsecurity: boolean }>(
        `SELECT c.relrowsecurity, c.relforcerowsecurity
         FROM pg_class c
         WHERE c.oid = to_regclass($1)`,
        [`${schemaName}.${table}`],
      );
      expect(rel.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    }
    const cartsPolicies = await client!.query<PolicyRow>(
      `SELECT pol.polname, pg_get_expr(pol.polqual, pol.polrelid) AS using_expr,
              pg_get_expr(pol.polwithcheck, pol.polrelid) AS check_expr, pol.polcmd
       FROM pg_policy pol
       WHERE pol.polrelid = to_regclass($1)
       ORDER BY pol.polname`,
      [`${schemaName}.carts`],
    );
    const customerPolicies = await client!.query<PolicyRow>(
      `SELECT pol.polname, pg_get_expr(pol.polqual, pol.polrelid) AS using_expr,
              pg_get_expr(pol.polwithcheck, pol.polrelid) AS check_expr, pol.polcmd
       FROM pg_policy pol
       WHERE pol.polrelid = to_regclass($1)
       ORDER BY pol.polname`,
      [`${schemaName}.customers`],
    );
    expect(cartsPolicies.rows).toEqual(policiesBefore?.carts);
    expect(customerPolicies.rows).toEqual(policiesBefore?.customers);
  });

  it("re-running the cleanup migration is a no-op", async () => {
    const before = await withAuthorized((db) => readSnapshot(db));
    const sql = cleanupSqlText();
    expect(sql).toBeTruthy();
    await client!.query(sql!);
    const after = await withAuthorized((db) => readSnapshot(db));
    expect(after).toEqual(before);
    expect(after.carts).toEqual(CARTS_AFTER);
    expect(after.lines).toEqual(LINES);
  });

  it("the cleanup migration runs on an empty carts table", () => {
    expect(emptyCleanup).toEqual({ ran: true, before: 0, after: 0 });
  });

  it("connects with the direct URL Prisma migrate uses", () => {
    expect(directUrl).toBe(resolveDirectUrl());
  });

  it("a loosened customers WITH CHECK accepts a cross-store Customer and the real policy does not", async () => {
    await client!.query("BEGIN");
    let strictRejected = false;
    try {
      await client!.query("SET LOCAL ROLE app_user");
      await client!.query("SELECT set_config('app.store_id', 'store-a', true)");
      try {
        await client!.query(
          `INSERT INTO ${quoted}.customers (id, store_id, user_id, name, email, updated_at)
           VALUES ('cust-cross', 'store-b', 'u1', 'Cross', 'cross-scratch@example.com', TIMESTAMP '${STAMP}')`,
        );
      } catch (error) {
        const coded = error as { code?: string; message?: string };
        strictRejected =
          coded.code === "42501" &&
          /row-level security policy for table "customers"/i.test(coded.message ?? "");
      }
    } finally {
      await rollbackQuietly(client!);
    }
    expect(strictRejected).toBe(true);

    await client!.query("BEGIN");
    try {
      await client!.query(
        `ALTER POLICY customers_isolation ON ${quoted}.customers USING (true) WITH CHECK (true)`,
      );
      await client!.query("SET LOCAL ROLE app_user");
      await client!.query("SELECT set_config('app.store_id', 'store-a', true)");
      await client!.query(
        `INSERT INTO ${quoted}.customers (id, store_id, user_id, name, email, updated_at)
         VALUES ('cust-cross', 'store-b', 'u1', 'Cross', 'cross-scratch@example.com', TIMESTAMP '${STAMP}')`,
      );
      const row = await client!.query<{ store_id: string }>(
        `SELECT store_id FROM ${quoted}.customers WHERE id = 'cust-cross'`,
      );
      expect(row.rows[0]?.store_id).toBe("store-b");
    } finally {
      await rollbackQuietly(client!);
    }
  });
});

describe.skipIf(!directUrl)("cart account orphan cleanup waits for a repaired link", () => {
  const schemaName = `tmp_co242r_${process.pid}`;
  const quoted = qi(schemaName);
  let setup: Client | undefined;
  let cleanup: Client | undefined;
  let locked = false;

  beforeAll(async () => {
    setup = new Client({ connectionString: directUrl });
    cleanup = new Client({ connectionString: directUrl });
    await setup.connect();
    await cleanup.connect();
    await setup.query("SELECT pg_advisory_lock($1)", [REPLAY_LOCK]);
    locked = true;
    try {
      await replayBeforeOld(setup, schemaName);
      await cleanup.query(`SET search_path = ${quoted}, public`);
      const ts = `TIMESTAMP '${STAMP}'`;
      await seedAsAdmin(
        setup,
        schemaName,
        `
          INSERT INTO ${quoted}.stores (id, slug, name, updated_at)
          VALUES ('store-a', 'store-a', 'Store A', ${ts});
          INSERT INTO ${quoted}.users (id, name, email, updated_at)
          VALUES ('u1', 'Ada Account', 'ada-repair@example.com', ${ts});
          INSERT INTO ${quoted}.listings (id, store_id, price, stock_mode, updated_at)
          VALUES ('listing-a', 'store-a', 1500, 'unlimited', ${ts});
          INSERT INTO ${quoted}.listing_variants (id, listing_id, label, price, weight_g, updated_at)
          VALUES ('variant-a', 'listing-a', '500g', 1500, 500, ${ts}),
                 ('variant-a2', 'listing-a', '1kg', 2500, 1000, ${ts});
          INSERT INTO ${quoted}.customers (id, store_id, user_id, name, email, updated_at)
          VALUES ('cust-wait', 'store-a', NULL, 'Wait', 'wait@example.com', ${ts}),
                 ('cust-linked', 'store-a', 'u1', 'Ada Account', 'ada-repair@example.com', ${ts}),
                 ('cust-guest', 'store-a', NULL, 'Guest', 'guest-repair@example.com', ${ts});
          INSERT INTO ${quoted}.carts (
            id, store_id, user_id, customer_id, payment_intent_id, source, created_at, updated_at
          ) VALUES
            ('cart-wait', 'store-a', 'missing', 'cust-wait', 'pi-wait', 'reorder', ${ts}, ${ts}),
            ('cart-other', 'store-a', 'gone', NULL, 'pi-other', 'reorder', ${ts}, ${ts}),
            ('cart-linked', 'store-a', 'u1', 'cust-linked', 'pi-linked', 'staff', ${ts}, ${ts}),
            ('cart-guest', 'store-a', NULL, 'cust-guest', 'pi-guest', 'guest', ${ts}, ${ts});
          INSERT INTO ${quoted}.cart_lines (
            id, store_id, cart_id, variant_id, qty, swap_rule, substitute_variant_id, created_at, updated_at
          ) VALUES
            ('line-wait', 'store-a', 'cart-wait', 'variant-a', 4, 'store_suggests', 'variant-a2', ${ts}, ${ts});
        `,
      );
      const oldSql = fs.readFileSync(path.join(MIGRATIONS, OLD_MIGRATION, "migration.sql"), "utf8");
      await setup.query(oldSql);
    } catch (error) {
      await rollbackQuietly(setup);
      throw error;
    }
  }, 180_000);

  afterAll(async () => {
    if (setup) await rollbackQuietly(setup);
    if (cleanup) await rollbackQuietly(cleanup);
    try {
      if (setup) await setup.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`);
    } catch {
      // Still unlock and close.
    }
    try {
      if (locked && setup) await setup.query("SELECT pg_advisory_unlock($1)", [REPLAY_LOCK]);
    } finally {
      locked = false;
      await cleanup?.end().catch(() => undefined);
      await setup?.end().catch(() => undefined);
    }
  }, 30_000);

  it("cleanup preserves an Account link repaired while it waits", async () => {
    const sql = cleanupSqlText();
    expect(sql, "cleanup migration file").toBeTruthy();
    await cleanup!.query("SET application_name = 'cart-orphan-cleanup'");
    await setup!.query("BEGIN");
    await setup!.query("SELECT set_config('app.is_platform_admin', 'true', true)");
    const repaired = await setup!.query(
      `UPDATE ${quoted}.carts SET user_id = 'u1' WHERE id = 'cart-wait'`,
    );
    expect(repaired.rowCount).toBe(1);

    let cleanupResult: Promise<unknown> | undefined;
    try {
      cleanupResult = cleanup!.query(sql!);
      const deadline = Date.now() + 8_000;
      let sawWait = false;
      let last = "";
      while (Date.now() < deadline) {
        const activity = await setup!.query<{
          wait_event_type: string | null;
          state: string;
        }>(
          `SELECT wait_event_type, state
           FROM pg_stat_activity
           WHERE application_name = 'cart-orphan-cleanup'
             AND pid <> pg_backend_pid()`,
        );
        last = JSON.stringify(activity.rows);
        if (activity.rows.some((row) => row.wait_event_type === "Lock" && row.state === "active")) {
          sawWait = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(sawWait, last).toBe(true);
    } finally {
      await setup!.query("COMMIT");
      await cleanupResult;
    }

    await setup!.query("BEGIN");
    try {
      await setup!.query("SET LOCAL ROLE app_user");
      await setup!.query("SELECT set_config('app.is_platform_admin', 'true', true)");
      const carts = await setup!.query<{ id: string; user_id: string | null; customer_id: string | null; payment_intent_id: string | null; source: string }>(
        `SELECT id, user_id, customer_id, payment_intent_id, source
         FROM ${quoted}.carts
         ORDER BY id`,
      );
      const lines = await setup!.query<{ id: string; qty: number; swap_rule: string; substitute_variant_id: string | null }>(
        `SELECT id, qty, swap_rule, substitute_variant_id
         FROM ${quoted}.cart_lines
         ORDER BY id`,
      );
      expect(carts.rows).toEqual([
        {
          id: "cart-guest",
          user_id: null,
          customer_id: "cust-guest",
          payment_intent_id: "pi-guest",
          source: "guest",
        },
        {
          id: "cart-linked",
          user_id: "u1",
          customer_id: "cust-linked",
          payment_intent_id: "pi-linked",
          source: "staff",
        },
        {
          id: "cart-other",
          user_id: null,
          customer_id: null,
          payment_intent_id: "pi-other",
          source: "reorder",
        },
        {
          id: "cart-wait",
          user_id: "u1",
          customer_id: "cust-wait",
          payment_intent_id: "pi-wait",
          source: "reorder",
        },
      ]);
      expect(lines.rows).toEqual([
        {
          id: "line-wait",
          qty: 4,
          swap_rule: "store_suggests",
          substitute_variant_id: "variant-a2",
        },
      ]);
    } finally {
      await rollbackQuietly(setup!);
    }
  }, 30_000);
});
