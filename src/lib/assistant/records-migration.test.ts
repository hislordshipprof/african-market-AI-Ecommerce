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
      await client.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${SCHEMA} TO app_user`,
      );
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
         AND tablename IN ('ai_conversations', 'ai_actions')
         AND policyname LIKE '%_isolation'`,
      [SCHEMA],
    );
    expect(policies.rows.map((row) => row.policyname).sort()).toEqual([
      "ai_actions_isolation",
      "ai_conversations_isolation",
    ]);
    for (const policy of policies.rows) {
      expect(policy.qual.toLowerCase()).toContain("exists");
      expect(policy.with_check.toLowerCase()).toContain("exists");
    }
  });

  it("adds cart_lines.source with a manual default and no backfill", async () => {
    const sql = fs.readFileSync(
      path.join(MIGRATIONS, "20261104220000_cart_line_source", "migration.sql"),
      "utf8",
    );
    expect(sql.toLowerCase()).not.toContain("update ");
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
