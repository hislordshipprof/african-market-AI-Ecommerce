import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";

const MIGRATIONS = path.resolve(__dirname, "../../../prisma/migrations");
const TARGET = "20261101000003_backfill_zero_weight_variants";
const SCHEMA = "tmp_backfill_110";

// Applies every migration to a scratch schema (an empty database), seeds zero-weight
// variants just before the backfill migration, then applies it.
describe("zero-weight variant backfill migration", () => {
  const client = new Client({ connectionString: process.env.DIRECT_URL ?? process.env.DATABASE_URL });

  beforeAll(async () => {
    await client.connect();
    await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await client.query(`CREATE SCHEMA ${SCHEMA}`);
    await client.query(`SET search_path = ${SCHEMA}, public`);
    const dirs = fs.readdirSync(MIGRATIONS).filter((d) => /^\d/.test(d)).sort();
    for (const d of dirs) {
      if (d === TARGET) {
        await client.query(`insert into stores(id,slug,name,updated_at) values('s1','s1','S1',now())`);
        await client.query(`insert into master_products(id,name,weight_g,updated_at) values('m1','M1',750,now()),('m2','M2',null,now())`);
        await client.query(`insert into listings(id,store_id,master_product_id,price,stock_mode,updated_at) values('l1','s1','m1',100,'counted',now()),('l2','s1','m2',100,'counted',now()),('l3','s1',null,100,'counted',now())`);
        await client.query(`insert into listing_variants(id,listing_id,label,price,weight_g,updated_at) values('v1','l1','a',1,0,now()),('v2','l2','b',1,0,now()),('v3','l3','c',1,0,now()),('v4','l1','d',1,500,now())`);
      }
      await client.query(fs.readFileSync(path.join(MIGRATIONS, d, "migration.sql"), "utf8"));
      if (d === TARGET) break;
    }
  }, 120_000);

  afterAll(async () => {
    await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await client.end();
  });

  it("uses the master product weight, else the 100 g fallback, and leaves valid rows alone", async () => {
    const { rows } = await client.query("select id, weight_g from listing_variants order by id");
    expect(rows).toEqual([
      { id: "v1", weight_g: 750 },
      { id: "v2", weight_g: 100 },
      { id: "v3", weight_g: 100 },
      { id: "v4", weight_g: 500 },
    ]);
    const zero = await client.query("select count(*)::int as n from listing_variants where weight_g = 0");
    expect(zero.rows[0].n).toBe(0);
  });

  it("rejects a zero-weight insert afterwards", async () => {
    await expect(
      client.query(`insert into listing_variants(id,listing_id,label,price,weight_g,updated_at) values('v9','l1','z',1,0,now())`),
    ).rejects.toThrow(/listing_variants_weight_g_positive/);
  });
});
