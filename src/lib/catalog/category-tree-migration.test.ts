import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveDirectUrl } from "../env";

// Replays every migration before #861 into a scratch schema as the migrating role (app_owner on lanes and
// CI, which forced RLS applies to), fills it the way production looks before #861, then runs the
// #861 migration twice.

const MIGRATIONS = path.resolve(__dirname, "../../../prisma/migrations");
const TREE_MIGRATION = "20261208000000_category_tree_16_aisles";
const SCHEMA = `tmp_t861_tree_${process.pid}`;
const REPLAY_LOCK = 199031030;

let directUrl: string | undefined;
try {
  directUrl = resolveDirectUrl() || undefined;
} catch {
  directUrl = undefined;
}

type Snapshot = Record<string, unknown[]>;

describe.skipIf(!directUrl)("the 16-aisle catalogue migration (#861)", () => {
  const client = new Client({ connectionString: directUrl });
  const treeSql = fs.readFileSync(path.join(MIGRATIONS, TREE_MIGRATION, "migration.sql"), "utf8");

  async function asAdminUser<T>(fn: () => Promise<T>): Promise<T> {
    await client.query("BEGIN");
    try {
      await client.query("SET LOCAL ROLE app_user");
      await client.query("SELECT set_config('app.is_platform_admin', 'true', true)");
      const result = await fn();
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }

  const rows = async <T extends object>(sql: string) => asAdminUser(async () => (await client.query<T & Record<string, unknown>>(sql)).rows);

  async function snapshot(): Promise<Snapshot> {
    return {
      categories: await rows("SELECT * FROM categories ORDER BY id"),
      products: await rows("SELECT id, category_id, updated_at FROM master_products ORDER BY id"),
      listings: await rows("SELECT id, category_id, master_product_id, updated_at FROM listings ORDER BY id"),
      proposals: await rows("SELECT id, category_id, updated_at FROM product_proposals ORDER BY id"),
    };
  }

  let before: Snapshot;
  let afterFirst: Snapshot;

  beforeAll(async () => {
    await client.connect();
    await client.query("SELECT pg_advisory_lock($1)", [REPLAY_LOCK]);
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await client.query(`CREATE SCHEMA ${SCHEMA}`);
      await client.query(`GRANT USAGE ON SCHEMA ${SCHEMA} TO app_user`);
      await client.query(`SET search_path = ${SCHEMA}, public`);
      const dirs = fs.readdirSync(MIGRATIONS).filter((dir) => /^\d/.test(dir) && dir < TREE_MIGRATION).sort();
      for (const dir of dirs) await client.query(fs.readFileSync(path.join(MIGRATIONS, dir, "migration.sql"), "utf8"));
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [REPLAY_LOCK]);
    }

    // Production before #861: the seed's 17 aisles, catalogue and demo products in them, an admin's own
    // aisle, subcategory and products, custom listings and a pending product proposal.
    // app_user may not create stores or users; the migrating role does, as platform admin.
    await client.query(`
      BEGIN;
      SELECT set_config('app.is_platform_admin', 'true', true);
      INSERT INTO stores (id, slug, name, updated_at) VALUES ('s861', 's861', 'Store 861', now());
      INSERT INTO users (id, email, name, email_verified, created_at, updated_at) VALUES ('u861', 'u861@example.test', 'U', true, now(), now());
      COMMIT;
    `);
    await asAdminUser(async () => {
      await client.query(`
        UPDATE categories SET name = 'Tubers & Roots', slug = 'tubers-and-roots' WHERE id = 'cat_tubers';
        UPDATE categories SET name = 'Oils & Butters', slug = 'oils-and-butters' WHERE id = 'cat_oils';
        INSERT INTO categories (id, name, slug, sort_order, tax_code, updated_at) VALUES
          ('cat_pantry', 'Pantry Staples', 'pantry-staples', 11, 'txcd_40040000', now()),
          ('cat_beans_legumes', 'Beans & Legumes', 'beans-and-legumes', 12, 'txcd_40040000', now()),
          ('cat_breakfast_dairy', 'Breakfast & Dairy', 'breakfast-and-dairy', 13, 'txcd_40040000', now()),
          ('cat_canned_packaged', 'Canned & Packaged', 'canned-and-packaged', 14, 'txcd_40040000', now()),
          ('cat_fruits', 'Fruits', 'fruits', 15, 'txcd_40040000', now()),
          ('cat_household', 'Household', 'household', 16, 'txcd_99999999', now()),
          ('cat_seasonings_sauces', 'Seasonings & Sauces', 'seasonings-and-sauces', 17, 'txcd_40040000', now()),
          ('adm_gifts', 'Gift Cards', 'gift-cards', 18, NULL, now());
        INSERT INTO categories (id, name, slug, sort_order, parent_id, updated_at) VALUES
          ('adm_exotic', 'Exotic Fruits', 'exotic-fruits', 1, 'cat_fruits', now());
        INSERT INTO master_products (id, name, category_id, updated_at) VALUES
          ('aboniki-balm', 'Aboniki balm', 'cat_beauty', now()),
          ('shea-butter-raw', 'Unrefined shea butter', 'cat_beauty', now()),
          ('palm-oil-red', 'Red palm oil', 'cat_oils', now()),
          ('garri-white', 'White garri', 'cat_tubers', now()),
          ('milo', 'Milo', 'cat_breakfast_dairy', now()),
          ('egusi-seeds-whole', 'Egusi', 'cat_spices', now()),
          ('bitter-kola', 'Bitter kola', 'cat_snacks', now()),
          ('dates', 'Dates', 'cat_fruits', now()),
          ('onga-seasoning', 'Onga', 'cat_seasonings_sauces', now()),
          ('mp_tomato_paste', 'Tomato Paste', 'cat_pantry', now()),
          ('admin-soursop', 'Soursop', 'cat_fruits', now()),
          ('admin-rambutan', 'Rambutan', 'adm_exotic', now()),
          ('admin-voucher', 'Voucher', 'adm_gifts', now());
        INSERT INTO listings (id, store_id, master_product_id, custom_name, category_id, price, stock_mode, updated_at) VALUES
          ('l-aboniki', 's861', 'aboniki-balm', NULL, NULL, 500, 'status', now()),
          ('l-dates', 's861', 'dates', NULL, NULL, 500, 'status', now()),
          ('l-custom-pantry', 's861', NULL, 'Gari biscuits', 'cat_pantry', 500, 'status', now()),
          ('l-custom-sauce', 's861', NULL, 'Shito', 'cat_seasonings_sauces', 500, 'status', now()),
          ('l-custom-beauty', 's861', NULL, 'Cocoa butter', 'cat_beauty', 500, 'status', now()),
          ('l-custom-gift', 's861', NULL, 'Gift card', 'adm_gifts', 500, 'status', now());
        INSERT INTO product_proposals (id, store_id, listing_id, proposed_by_id, name, category_id, updated_at) VALUES
          ('p-soursop', 's861', 'l-custom-pantry', 'u861', 'Soursop', 'cat_fruits', now());
      `);
    });
    before = await snapshot();
    await client.query(treeSql);
    afterFirst = await snapshot();
  }, 240_000);

  afterAll(async () => {
    await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => undefined);
    await client.end();
  });

  it("runs as a role that forced row-level security applies to", async () => {
    const role = await client.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
    );
    expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it("builds the 16 aisles in order, each with its subcategories, and keeps an admin's own aisle", async () => {
    const aisles = await rows<{ id: string; name: string; slug: string }>("SELECT id, name, slug FROM categories WHERE parent_id IS NULL ORDER BY sort_order, id");
    expect(aisles.map((aisle) => aisle.name)).toEqual([
      "Tubers & Roots", "Fresh Produce", "Fufu, Flours & Swallow", "Rice, Grains & Beans", "Soup Ingredients",
      "Spices & Seasonings", "Oils, Sauces & Condiments", "Fish & Meat", "Frozen", "Canned & Packaged",
      "Breakfast & Dairy", "Snacks & Sweets", "Drinks", "Health & Wellness", "Beauty & Personal Care",
      "Household & Kitchen", "Gift Cards",
    ]);
    const health = await rows<{ name: string; tax_code: string }>(
      "SELECT name, tax_code FROM categories WHERE parent_id = 'cat_health_wellness' ORDER BY sort_order",
    );
    expect(health).toEqual([
      { name: "Balms & Ointments", tax_code: "txcd_32020002" },
      { name: "Bitters & Herbal Remedies", tax_code: "txcd_40090001" },
      { name: "Natural Remedies", tax_code: "txcd_40090001" },
      { name: "Vitamins & Supplements", tax_code: "txcd_40090001" },
    ]);
    const counts = await rows<{ n: number }>("SELECT count(*)::int AS n FROM categories WHERE parent_id IS NOT NULL AND id LIKE 'sub\\_%'");
    expect(counts[0].n).toBe(79);
  });

  it("moves catalogue products by the section 5 mapping, and every other row to its old aisle's default", async () => {
    const products = Object.fromEntries((afterFirst.products as Array<{ id: string; category_id: string }>).map((row) => [row.id, row.category_id]));
    expect(products).toEqual({
      "aboniki-balm": "sub_balms_ointments",
      "shea-butter-raw": "sub_shea_natural_butters",
      "palm-oil-red": "sub_palm_oil",
      "garri-white": "sub_garri_cassava_flour",
      milo: "sub_malt_cocoa_nutrition",
      "egusi-seeds-whole": "sub_egusi_melon_seeds",
      "bitter-kola": "sub_bitters_herbal_remedies",
      dates: "sub_nuts_seeds_dried_fruit",
      "onga-seasoning": "sub_stock_cubes_bouillon",
      mp_tomato_paste: "sub_tomato_paste",
      "admin-soursop": "sub_fresh_fruits",
      "admin-rambutan": "adm_exotic",
      "admin-voucher": "adm_gifts",
    });
    const listings = Object.fromEntries((afterFirst.listings as Array<{ id: string; category_id: string | null }>).map((row) => [row.id, row.category_id]));
    expect(listings).toEqual({
      "l-aboniki": null,
      "l-dates": null,
      "l-custom-pantry": "sub_instant_ready_meals",
      "l-custom-sauce": "sub_stock_cubes_bouillon",
      "l-custom-beauty": "sub_skin_care_body_creams",
      "l-custom-gift": "adm_gifts",
    });
    expect((afterFirst.proposals as Array<{ category_id: string }>)[0].category_id).toBe("sub_fresh_fruits");
    const exotic = await rows<{ parent_id: string }>("SELECT parent_id FROM categories WHERE id = 'adm_exotic'");
    expect(exotic).toEqual([{ parent_id: "cat_vegetables" }]);
  });

  it("leaves no listing without an aisle and retires the three old aisles only once they are empty", async () => {
    const orphans = await rows(`
      SELECT l.id FROM listings l
      LEFT JOIN master_products mp ON mp.id = l.master_product_id
      LEFT JOIN categories c ON c.id = COALESCE(mp.category_id, l.category_id)
      WHERE c.id IS NULL`);
    expect(orphans).toEqual([]);
    const retired = await rows("SELECT id FROM categories WHERE id IN ('cat_pantry', 'cat_fruits', 'cat_seasonings_sauces')");
    expect(retired).toEqual([]);
    const stillInOldAisle = await rows(`
      SELECT id FROM master_products WHERE category_id IN (
        'cat_tubers', 'cat_grains', 'cat_spices', 'cat_oils', 'cat_vegetables', 'cat_fish_meat', 'cat_frozen', 'cat_snacks',
        'cat_drinks', 'cat_beauty', 'cat_beans_legumes', 'cat_breakfast_dairy', 'cat_canned_packaged', 'cat_household')`);
    expect(stillInOldAisle).toEqual([]);
    expect(before.listings).toHaveLength(afterFirst.listings.length);
    expect(before.products).toHaveLength(afterFirst.products.length);
  });

  it("changes nothing when it runs a second time", async () => {
    await client.query(treeSql);
    expect(await snapshot()).toEqual(afterFirst);
  });

  it("fails whole, changing nothing, when a row would be left in a retired aisle", async () => {
    // A listing in a retired aisle that the migration does not know how to move: the delete refuses.
    const listingMove = "UPDATE listings SET category_id = old_default->>category_id, updated_at = now() WHERE old_default ? category_id;";
    const blocked = treeSql.replace(listingMove, "");
    expect(blocked).not.toBe(treeSql);
    await asAdminUser(() => client.query(`
      INSERT INTO categories (id, name, slug, sort_order, updated_at) VALUES ('cat_fruits', 'Old fruits', 'fruits', 15, now());
      INSERT INTO listings (id, store_id, custom_name, category_id, price, stock_mode, updated_at) VALUES ('l-late', 's861', 'Late fruit', 'cat_fruits', 500, 'status', now());
    `));
    const beforeBlocked = await snapshot();
    await expect(client.query(blocked)).rejects.toThrow(/foreign key/);
    expect(await snapshot()).toEqual(beforeBlocked);
  });
});
