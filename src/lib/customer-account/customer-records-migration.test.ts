import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const MIGRATIONS = path.resolve(__dirname, "../../../prisma/migrations");
const SCHEMA = "tmp_t248_account";
const REPLAY_LOCK = 199031030;
const connectionString = process.env.DIRECT_URL ?? process.env.DATABASE_URL;

describe.skipIf(!connectionString)("customer account records migration", () => {
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
      await client.query(`GRANT USAGE ON SCHEMA ${SCHEMA} TO app_runtime`);
      await client.query(`SET search_path = ${SCHEMA}`);
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [REPLAY_LOCK]);
    }
  }, 120_000);

  afterAll(async () => {
    await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await client.end();
  });

  it("customer_addresses and platform_customer_profiles force RLS with one app.user_id policy and no store or admin policy", async () => {
    const tables = await client.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity
       FROM pg_class
       WHERE relname IN ('platform_customer_profiles', 'customer_addresses', 'card_save_consents')
         AND relnamespace = $1::regnamespace`,
      [SCHEMA],
    );
    expect(tables.rows).toHaveLength(3);
    expect(tables.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity)).toBe(true);

    const policies = await client.query<{ tablename: string; policyname: string; qual: string; with_check: string }>(
      `SELECT tablename, policyname, qual, with_check
       FROM pg_policies
       WHERE schemaname = $1`,
      [SCHEMA],
    );
    const owned = policies.rows.filter((row) =>
      ["platform_customer_profiles", "customer_addresses", "card_save_consents"].includes(row.tablename),
    );
    expect(owned.map((row) => row.policyname).sort()).toEqual([
      "card_save_consents_owner",
      "customer_addresses_owner",
      "platform_customer_profiles_owner",
    ]);
    for (const policy of owned) {
      expect(policy.qual).toContain("app.user_id");
      expect(policy.with_check).toContain("app.user_id");
      expect(policy.qual).not.toContain("app.store_id");
      expect(policy.qual).not.toContain("app.is_platform_admin");
    }
  });

  it("fresh migration enforces FKs, nullable unique Stripe id, full user index, partial default index and least grants", async () => {
    const grants = await client.query<{ table_name: string; privilege_type: string }>(
      `SELECT table_name, privilege_type
       FROM information_schema.table_privileges
       WHERE table_schema = $1 AND grantee = 'app_user'
         AND table_name IN ('platform_customer_profiles', 'customer_addresses', 'card_save_consents')`,
      [SCHEMA],
    );
    const byTable = new Map<string, string[]>();
    for (const row of grants.rows) {
      byTable.set(row.table_name, [...(byTable.get(row.table_name) ?? []), row.privilege_type].sort());
    }
    for (const name of ["platform_customer_profiles", "customer_addresses", "card_save_consents"]) {
      expect(byTable.get(name)).toEqual(["DELETE", "INSERT", "SELECT", "UPDATE"]);
    }

    const indexes = await client.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = $1
         AND indexname IN (
           'customer_addresses_user_id_idx',
           'customer_addresses_one_default_idx',
           'platform_customer_profiles_stripe_customer_id_key'
         )`,
      [SCHEMA],
    );
    const defs = new Map(indexes.rows.map((row) => [row.indexname, row.indexdef]));
    expect(defs.get("customer_addresses_user_id_idx")).toContain("(user_id)");
    expect(defs.get("customer_addresses_one_default_idx")).toContain("WHERE");
    expect(defs.get("platform_customer_profiles_stripe_customer_id_key")).toContain("stripe_customer_id");

    await client.query(`INSERT INTO users (id, name, email, updated_at) VALUES ('userA', 'A', 'a@t248.test', now())`);
    await client.query(`INSERT INTO users (id, name, email, updated_at) VALUES ('userB', 'B', 'b@t248.test', now())`);
    await asUser("userA", `
      INSERT INTO platform_customer_profiles (user_id, updated_at)
      VALUES ('userA', now())
    `);
    await asUser("userB", `
      INSERT INTO platform_customer_profiles (user_id, stripe_customer_id, updated_at)
      VALUES ('userB', NULL, now())
    `);
    const nullsA = await asUser(
      "userA",
      `SELECT count(*)::int AS n FROM platform_customer_profiles WHERE stripe_customer_id IS NULL`,
    );
    const nullsB = await asUser(
      "userB",
      `SELECT count(*)::int AS n FROM platform_customer_profiles WHERE stripe_customer_id IS NULL`,
    );
    expect(nullsA.rows[0].n).toBe(1);
    expect(nullsB.rows[0].n).toBe(1);

    await expect(asUser("userB", `
      INSERT INTO customer_addresses (id, user_id, label, line1, city, state, zip, is_default, updated_at)
      VALUES ('addr-cross', 'userA', 'Home', '1 St', 'Honolulu', 'HI', '96813', true, now())
    `)).rejects.toMatchObject({ code: "42501" });

    await asUser("userA", `
      INSERT INTO customer_addresses (id, user_id, label, line1, city, state, zip, is_default, updated_at)
      VALUES ('addrA', 'userA', 'Home', '1 St', 'Honolulu', 'HI', '96813', true, now())
    `);
    await expect(asUser("userA", `
      UPDATE customer_addresses SET user_id = 'userB' WHERE id = 'addrA'
    `)).rejects.toMatchObject({ code: "42501" });
    const still = await asUser("userA", `SELECT user_id FROM customer_addresses WHERE id = 'addrA'`);
    expect(still.rows[0]?.user_id).toBe("userA");
  });

  async function asUser(userId: string, sql: string) {
    await client.query("BEGIN");
    try {
      await client.query("SET LOCAL ROLE app_user");
      await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
      const result = await client.query(sql);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
});
