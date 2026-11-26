import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveDirectUrl } from "../env";

// Replays every migration into a scratch schema with categories RLS still forced, as the migrating
// role (app_owner on lanes and CI). Categories that exist before #65 are seeded just before
// 20261118120000_sales_tax, then read back as app_user with platform-admin visibility.

const MIGRATIONS = path.resolve(__dirname, "../../../prisma/migrations");
const TAX_MIGRATION = "20261118120000_sales_tax";
// #861 rebuilt the aisles afterwards; this test reads the slugs the backfill left.
const CATEGORY_TREE_MIGRATION = "20261208000000_category_tree_16_aisles";
const SCHEMA = `tmp_t65_taxcode_${process.pid}`;
const REPLAY_LOCK = 199031030;
const FOOD = "txcd_40040000";

let directUrl: string | undefined;
try {
  directUrl = resolveDirectUrl() || undefined;
} catch {
  directUrl = undefined;
}

describe.skipIf(!directUrl)("category tax code backfill under forced RLS (#65)", () => {
  const client = new Client({ connectionString: directUrl });

  async function asAdminUser<T>(fn: () => Promise<T>): Promise<T> {
    await client.query("BEGIN");
    try {
      await client.query("SET LOCAL ROLE app_user");
      await client.query("SELECT set_config('app.is_platform_admin', 'true', true)");
      return await fn();
    } finally {
      await client.query("ROLLBACK");
    }
  }

  beforeAll(async () => {
    await client.connect();
    await client.query("SELECT pg_advisory_lock($1)", [REPLAY_LOCK]);
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await client.query(`CREATE SCHEMA ${SCHEMA}`);
      await client.query(`GRANT USAGE ON SCHEMA ${SCHEMA} TO app_user`);
      await client.query(`SET search_path = ${SCHEMA}, public`);
      const dirs = fs.readdirSync(MIGRATIONS).filter((dir) => /^\d/.test(dir) && dir < CATEGORY_TREE_MIGRATION).sort();
      for (const dir of dirs) {
        if (dir === TAX_MIGRATION) {
          // Categories the platform admin added after the first ten (seed.ts names, as on preview).
          await client.query("BEGIN");
          await client.query("SELECT set_config('app.is_platform_admin', 'true', true)");
          await client.query("SET LOCAL ROLE app_user");
          await client.query(`
            INSERT INTO categories (id, name, slug, sort_order, updated_at) VALUES
              ('t-pantry', 'Pantry Staples', 'pantry-staples', 11, now()),
              ('t-household', 'Household', 'household', 16, now()),
              ('t-sauces', 'Seasonings & Sauces', 'seasonings-and-sauces', 17, now()),
              ('t-gifts', 'Gift Cards', 'gift-cards', 18, now())`);
          await client.query("COMMIT");
        }
        await client.query(fs.readFileSync(path.join(MIGRATIONS, dir, "migration.sql"), "utf8"));
        if (dir === TAX_MIGRATION) {
          // An admin set a code by hand before the backfill ran; it is kept.
          await client.query("BEGIN");
          await client.query("SET LOCAL ROLE app_user");
          await client.query("SELECT set_config('app.is_platform_admin', 'true', true)");
          await client.query("UPDATE categories SET tax_code = 'txcd_40070000' WHERE slug = 'snacks'");
          await client.query("COMMIT");
        }
      }
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [REPLAY_LOCK]);
    }
  }, 180_000);

  afterAll(async () => {
    await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => undefined);
    await client.end();
  });

  it("replays as a role that forced row-level security applies to", async () => {
    const role = await client.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
    );
    expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    const categories = await client.query<{ relforcerowsecurity: boolean }>(
      `SELECT relforcerowsecurity FROM pg_class WHERE relname = 'categories' AND relnamespace = $1::regnamespace`,
      [SCHEMA],
    );
    expect(categories.rows).toEqual([{ relforcerowsecurity: true }]);
  });

  it("every grocery category gets the food code, the others their own, a hand-set code is kept, and an unknown slug stays empty", async () => {
    const rows = await asAdminUser(() =>
      client.query<{ slug: string; tax_code: string | null }>(`SELECT slug, tax_code FROM categories ORDER BY slug COLLATE "C"`),
    );
    expect(rows.rows).toEqual([
      { slug: "beauty", tax_code: "txcd_32050025" },
      { slug: "drinks", tax_code: "txcd_41040008" },
      { slug: "fish-and-meat", tax_code: FOOD },
      { slug: "frozen", tax_code: FOOD },
      { slug: "gift-cards", tax_code: null },
      { slug: "grains-and-flours", tax_code: FOOD },
      { slug: "household", tax_code: "txcd_99999999" },
      { slug: "oils", tax_code: FOOD },
      { slug: "pantry-staples", tax_code: FOOD },
      { slug: "seasonings-and-sauces", tax_code: FOOD },
      { slug: "snacks", tax_code: "txcd_40070000" },
      { slug: "spices", tax_code: FOOD },
      { slug: "tubers", tax_code: FOOD },
      { slug: "vegetables", tax_code: FOOD },
    ]);
  });
});
