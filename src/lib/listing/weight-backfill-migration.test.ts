import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";

const MIGRATIONS = path.resolve(__dirname, "../../../prisma/migrations");
const TARGET = "20261101000003_backfill_zero_weight_variants";
const SCHEMA = "tmp_backfill_110";

// Run against a scratch schema so no real data is touched. The migration file itself must never
// be edited (Prisma checksums applied migrations); this test replays it instead.
//
// RLS assumption: the backfill UPDATEs listing_variants, which has forced row-level security. It only
// works because the migrating role (DIRECT_URL, the table owner / BYPASSRLS) is not subject to it.
// A plain role would match zero rows, so the CHECK at the end of the migration would fail loudly
// rather than silently skipping rows. This test disables RLS on the scratch tables to model that.
//
// Applies every migration to a scratch schema (an empty database), seeds zero-weight
// variants just before the backfill migration, then applies it.
const connectionString = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
// Shared with the listing_imports index replay. Concurrent CREATE in public raises
// "tuple concurrently updated" when both scratch schemas replay at once.
const REPLAY_LOCK = 199031030;

describe.skipIf(!connectionString)("zero-weight variant backfill migration", () => {
  const client = new Client({ connectionString });

  beforeAll(async () => {
    await client.connect();
    await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await client.query(`CREATE SCHEMA ${SCHEMA}`);
    await client.query(`SET search_path = ${SCHEMA}, public`);
    await client.query("SELECT pg_advisory_lock($1)", [REPLAY_LOCK]);
    const dirs = fs.readdirSync(MIGRATIONS).filter((d) => /^\d/.test(d)).sort();
    try {
      for (const d of dirs) {
        if (d === TARGET) {
          for (const t of ["stores", "master_products", "listings", "listing_variants"])
            await client.query(`ALTER TABLE ${t} DISABLE ROW LEVEL SECURITY`);
          await client.query(`insert into stores(id,slug,name,updated_at) values('s1','s1','S1',now())`);
          await client.query(`insert into master_products(id,name,weight_g,updated_at) values('m1','M1',750,now()),('m2','M2',null,now())`);
          await client.query(`insert into listings(id,store_id,master_product_id,price,stock_mode,updated_at) values('l1','s1','m1',100,'counted',now()),('l2','s1','m2',100,'counted',now()),('l3','s1',null,100,'counted',now())`);
          await client.query(`insert into listing_variants(id,listing_id,label,price,weight_g,updated_at) values('v1','l1','a',1,0,now()),('v2','l2','b',1,0,now()),('v3','l3','c',1,0,now()),('v4','l1','d',1,500,now()),('v5','l1','e',1,-5,now()),('v6','l3','f',1,-1,now())`);
        }
        await client.query(fs.readFileSync(path.join(MIGRATIONS, d, "migration.sql"), "utf8"));
        if (d === TARGET) break;
      }
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [REPLAY_LOCK]);
    }
  }, 120_000);

  afterAll(async () => {
    await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await client.end();
  });

  it("uses the master product weight, else the 100 g fallback (zero and negative), and leaves valid rows alone", async () => {
    const { rows } = await client.query("select id, weight_g from listing_variants order by id");
    expect(rows).toEqual([
      { id: "v1", weight_g: 750 },
      { id: "v2", weight_g: 100 },
      { id: "v3", weight_g: 100 },
      { id: "v4", weight_g: 500 },
      { id: "v5", weight_g: 100 },
      { id: "v6", weight_g: 100 },
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
