import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { describe, expect, it, beforeAll, afterAll } from "vitest";

const MIGRATIONS = path.resolve(__dirname, "../../../prisma/migrations");
const SCHEMA = "tmp_ai145_apply";
const REPLAY_LOCK = 199031030;
const connectionString = process.env.DIRECT_URL ?? process.env.DATABASE_URL;

describe.skipIf(!connectionString)("assistant records migration", () => {
  const client = new Client({ connectionString });

  beforeAll(async () => {
    await client.connect();
    await client.query("SELECT pg_advisory_lock($1)", [REPLAY_LOCK]);
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await client.query(`CREATE SCHEMA ${SCHEMA}`);
      await client.query(`SET search_path = ${SCHEMA}, public`);
      const dirs = fs.readdirSync(MIGRATIONS).filter((dir) => /^\d/.test(dir)).sort();
      for (const dir of dirs) {
        await client.query(fs.readFileSync(path.join(MIGRATIONS, dir, "migration.sql"), "utf8"));
      }
      await client.query(`GRANT USAGE ON SCHEMA ${SCHEMA} TO app_user`);
      await client.query(`SET search_path = ${SCHEMA}`);
      await seed(client);
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [REPLAY_LOCK]);
    }
  }, 120_000);

  afterAll(async () => {
    await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await client.end();
  });

  it("forces RLS and checks the cart and customer on both policy clauses", async () => {
    const tables = await client.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity
       FROM pg_class
       WHERE relname IN ('ai_conversations', 'ai_actions')
         AND relnamespace = $1::regnamespace`,
      [SCHEMA],
    );
    expect(tables.rows).toHaveLength(2);
    expect(tables.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity)).toBe(true);

    const policies = await client.query<{ policyname: string; qual: string; with_check: string }>(
      `SELECT policyname, qual, with_check
       FROM pg_policies
       WHERE schemaname = $1
         AND tablename IN ('ai_conversations', 'ai_actions')`,
      [SCHEMA],
    );
    expect(policies.rows.map((row) => row.policyname).sort()).toEqual([
      "ai_actions_isolation",
      "ai_actions_platform_admin",
      "ai_conversations_isolation",
      "ai_conversations_platform_admin",
    ]);
    for (const policy of policies.rows.filter((row) => row.policyname.endsWith("_isolation"))) {
      expect(policy.qual.toLowerCase()).toContain("exists");
      expect(policy.with_check.toLowerCase()).toContain("exists");
    }
    for (const policy of policies.rows.filter((row) => row.policyname.endsWith("_platform_admin"))) {
      expect(policy.qual).toContain("app.is_platform_admin");
      expect(policy.with_check).toContain("app.is_platform_admin");
    }
  });

  it("creates the platform spend ledger on an empty schema without RLS or a delete grant", async () => {
    const sql = fs.readFileSync(
      path.join(MIGRATIONS, "20261104230000_assistant_spend_days", "migration.sql"),
      "utf8",
    );
    const upper = sql.toUpperCase();
    expect(upper).not.toContain("GRANT DELETE");
    expect(upper).not.toContain("DELETE FROM");
    const table = await client.query<{ relrowsecurity: boolean }>(
      `SELECT relrowsecurity
       FROM pg_class
       WHERE relname = 'assistant_spend_days'
         AND relnamespace = $1::regnamespace`,
      [SCHEMA],
    );
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0]?.relrowsecurity).toBe(false);
    const grants = await client.query<{ table_name: string; privilege_type: string }>(
      `SELECT table_name, privilege_type
       FROM information_schema.table_privileges
       WHERE table_schema = $1
         AND grantee = 'app_user'
         AND table_name IN ('assistant_spend_days', 'assistant_spend_calls', 'assistant_retention_batches')`,
      [SCHEMA],
    );
    const byTable = new Map<string, Set<string>>();
    for (const row of grants.rows) {
      const set = byTable.get(row.table_name) ?? new Set<string>();
      set.add(row.privilege_type);
      byTable.set(row.table_name, set);
    }
    expect([...(byTable.get("assistant_spend_days") ?? [])].sort()).toEqual(["INSERT", "SELECT", "UPDATE"]);
    expect([...(byTable.get("assistant_spend_calls") ?? [])].sort()).toEqual(["INSERT", "SELECT"]);
    expect([...(byTable.get("assistant_retention_batches") ?? [])].sort()).toEqual(["INSERT", "SELECT"]);
    for (const name of ["assistant_spend_days", "assistant_spend_calls", "assistant_retention_batches"]) {
      expect(byTable.get(name)?.has("DELETE")).toBe(false);
    }
  });

  it("records the unique cart index, foreign-key actions, and app_user cascade behavior", async () => {
    const indexes = await client.query<{
      schemaname: string;
      tablename: string;
      indexname: string;
      amname: string;
      indisunique: boolean;
      indnkeyatts: number;
      indnatts: number;
      indisvalid: boolean;
      indisready: boolean;
      indislive: boolean;
      predicate_is_null: boolean;
      expressions_are_null: boolean;
      key_atts: string[];
    }>(
      `SELECT n.nspname AS schemaname,
              t.relname AS tablename,
              i.relname AS indexname,
              am.amname,
              ix.indisunique,
              ix.indnkeyatts,
              ix.indnatts,
              ix.indisvalid,
              ix.indisready,
              ix.indislive,
              ix.indpred IS NULL AS predicate_is_null,
              ix.indexprs IS NULL AS expressions_are_null,
              (
                SELECT array_agg(a.attname ORDER BY cols.ord)::text[]
                FROM unnest(ix.indkey::smallint[]) WITH ORDINALITY AS cols(attnum, ord)
                JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = cols.attnum
                WHERE cols.ord <= ix.indnkeyatts
              ) AS key_atts
       FROM pg_index ix
       JOIN pg_class i ON i.oid = ix.indexrelid
       JOIN pg_class t ON t.oid = ix.indrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       JOIN pg_namespace ni ON ni.oid = i.relnamespace
       JOIN pg_am am ON am.oid = i.relam
       WHERE n.nspname = $1
         AND ni.nspname = $1
         AND t.relname = 'ai_conversations'
         AND i.relname IN (
           'ai_conversations_cart_id_idx',
           'ai_conversations_store_id_cart_id_key',
           'ai_conversations_store_id_idx',
           'ai_conversations_created_at_idx',
           'ai_conversations_customer_id_idx'
         )
       ORDER BY i.relname`,
      [SCHEMA],
    );
    const plain = {
      amname: "btree",
      indisunique: false,
      indnkeyatts: 1,
      indnatts: 1,
      indisvalid: true,
      indisready: true,
      indislive: true,
      predicate_is_null: true,
      expressions_are_null: true,
    };
    expect(indexes.rows).toEqual([
      {
        schemaname: "tmp_ai145_apply",
        tablename: "ai_conversations",
        indexname: "ai_conversations_cart_id_idx",
        ...plain,
        key_atts: ["cart_id"],
      },
      {
        schemaname: "tmp_ai145_apply",
        tablename: "ai_conversations",
        indexname: "ai_conversations_created_at_idx",
        ...plain,
        key_atts: ["created_at"],
      },
      {
        schemaname: "tmp_ai145_apply",
        tablename: "ai_conversations",
        indexname: "ai_conversations_customer_id_idx",
        ...plain,
        key_atts: ["customer_id"],
      },
      {
        schemaname: "tmp_ai145_apply",
        tablename: "ai_conversations",
        indexname: "ai_conversations_store_id_cart_id_key",
        amname: "btree",
        indisunique: true,
        indnkeyatts: 2,
        indnatts: 2,
        indisvalid: true,
        indisready: true,
        indislive: true,
        predicate_is_null: true,
        expressions_are_null: true,
        key_atts: ["store_id", "cart_id"],
      },
      {
        schemaname: "tmp_ai145_apply",
        tablename: "ai_conversations",
        indexname: "ai_conversations_store_id_idx",
        ...plain,
        key_atts: ["store_id"],
      },
    ]);
    const keys = await client.query<{ conname: string; confdeltype: string }>(
      `SELECT con.conname, con.confdeltype
       FROM pg_constraint con
       JOIN pg_class rel ON rel.oid = con.conrelid
       JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
       WHERE nsp.nspname = $1
         AND con.contype = 'f'
         AND con.conname IN (
           'ai_conversations_cart_id_fkey',
           'ai_conversations_customer_id_fkey',
           'ai_actions_conversation_id_fkey'
         )`,
      [SCHEMA],
    );
    const action = new Map(keys.rows.map((row) => [row.conname, row.confdeltype]));
    expect(action.get("ai_conversations_cart_id_fkey")).toBe("c");
    expect(action.get("ai_conversations_customer_id_fkey")).toBe("n");
    expect(action.get("ai_actions_conversation_id_fkey")).toBe("c");

    await client.query("BEGIN");
    await client.query("SELECT set_config('app.is_platform_admin', 'true', true)");
    await client.query(`
      INSERT INTO customers (id, store_id, name, updated_at)
      VALUES ('custA', 'sA', 'Ada', now())
    `);
    await client.query(`
      INSERT INTO carts (id, store_id, source, created_at, updated_at)
      VALUES ('cartC', 'sA', 'manual', now(), now())
    `);
    await client.query(`
      INSERT INTO ai_conversations (id, store_id, cart_id, customer_id, model, messages, created_at, last_message_at)
      VALUES ('convC', 'sA', 'cartC', 'custA', 'claude-haiku-5-5', '[]'::jsonb, now(), now())
    `);
    await client.query(`
      INSERT INTO ai_actions (id, store_id, conversation_id, tool, input, output, ok)
      VALUES ('actC', 'sA', 'convC', 'search_catalog', '{}'::jsonb, '{}'::jsonb, true)
    `);
    await client.query("COMMIT");
    await asAppUser(`DELETE FROM customers WHERE id = 'custA'`);
    const nulled = await asPlatformAdmin(client, `SELECT customer_id FROM ai_conversations WHERE id = 'convC'`);
    expect(nulled.rows[0]?.customer_id).toBeNull();
    await asAppUser(`DELETE FROM carts WHERE id = 'cartC'`);
    expect((await asPlatformAdmin(client, `SELECT id FROM ai_conversations WHERE id = 'convC'`)).rows).toEqual([]);
    expect((await asPlatformAdmin(client, `SELECT id FROM ai_actions WHERE id = 'actC'`)).rows).toEqual([]);
  });

  it("adds cart_lines.source with a manual default and no backfill", async () => {
    const sql = fs.readFileSync(
      path.join(MIGRATIONS, "20261104220000_cart_line_source", "migration.sql"),
      "utf8",
    );
    const statements = sql.replace(/--[^\n]*/g, "").toLowerCase();
    expect(statements).not.toContain("update ");
    const column = await client.query<{ column_default: string; is_nullable: string }>(
      `SELECT column_default, is_nullable
       FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'cart_lines' AND column_name = 'source'`,
      [SCHEMA],
    );
    expect(column.rows[0]?.is_nullable).toBe("NO");
    expect(column.rows[0]?.column_default).toContain("manual");
  });

  it("rejects store B writing a conversation onto store A's cart as app_user", async () => {
    await expect(client.query(`
      BEGIN;
      SET LOCAL ROLE app_user;
      SELECT set_config('app.store_id', 'sB', true);
      INSERT INTO ai_conversations (id, store_id, cart_id, model, messages, created_at, last_message_at)
      VALUES ('bad-cross', 'sB', 'cartA', 'claude-haiku-5-5', '[]'::jsonb, now(), now());
      COMMIT;
    `)).rejects.toMatchObject({ code: "42501" });
    await client.query("ROLLBACK");
    const left = await client.query(`SELECT id FROM ai_conversations WHERE id = 'bad-cross'`);
    expect(left.rows).toEqual([]);
  });
});

async function asPlatformAdmin(client: Client, sql: string) {
  await client.query("BEGIN");
  try {
    await client.query("SELECT set_config('app.is_platform_admin', 'true', true)");
    const result = await client.query(sql);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function asAppUser(sql: string) {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET search_path = ${SCHEMA}`);
    await client.query("SET LOCAL ROLE app_user");
    await client.query("SELECT set_config('app.is_platform_admin', 'true', true)");
    await client.query(sql);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}

async function seed(client: Client) {
  await client.query("BEGIN");
  await client.query("SELECT set_config('app.is_platform_admin', 'true', true)");
  await client.query(`
    INSERT INTO stores (id, slug, name, updated_at) VALUES
      ('sA', 'ai145-a', 'Store A', now()),
      ('sB', 'ai145-b', 'Store B', now())
  `);
  await client.query(`
    INSERT INTO carts (id, store_id, source, created_at, updated_at) VALUES
      ('cartA', 'sA', 'manual', now(), now()),
      ('cartB', 'sB', 'manual', now(), now())
  `);
  await client.query("SELECT set_config('app.is_platform_admin', 'false', true)");
  await client.query("COMMIT");
}
