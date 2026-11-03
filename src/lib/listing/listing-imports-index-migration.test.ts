import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";

const execFileAsync = promisify(execFile);

const MIGRATIONS = path.resolve(__dirname, "../../../prisma/migrations");
const SCHEMA = "tmp_listing_imports_199";
const connectionString = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
// Shared with the weight-backfill replay. Concurrent CREATE in public raises
// "tuple concurrently updated" when both scratch schemas replay at once.
const REPLAY_LOCK = 199031030;

// Replays every migration into an empty scratch schema. listing_imports has forced RLS;
// index changes do not read or write rows, so the table owner (DIRECT_URL) can create
// them whether or not RLS is enabled. Prisma checksums applied migrations, so this test
// replays the SQL instead of editing 20261102000000_listing_imports.

describe.skipIf(!connectionString)("listing_imports created_by index migration", () => {
  const client = new Client({ connectionString });

  beforeAll(async () => {
    await client.connect();
    await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await client.query(`CREATE SCHEMA ${SCHEMA}`);
    await client.query(`SET search_path = ${SCHEMA}, public`);
    await client.query("SELECT pg_advisory_lock($1)", [REPLAY_LOCK]);
    try {
      const dirs = fs.readdirSync(MIGRATIONS).filter((d) => /^\d/.test(d)).sort();
      for (const dir of dirs) {
        await client.query(fs.readFileSync(path.join(MIGRATIONS, dir, "migration.sql"), "utf8"));
      }
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [REPLAY_LOCK]);
    }
  }, 120_000);

  afterAll(async () => {
    await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await client.end();
  });

  it("indexes created_by_id, keeps (store_id, status), and drops store_id alone", async () => {
    const { rows } = await client.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef
       FROM pg_indexes
       WHERE schemaname = $1 AND tablename = 'listing_imports'
       ORDER BY indexname`,
      [SCHEMA],
    );
    const names = rows.map((row) => row.indexname);
    expect(names).toContain("listing_imports_created_by_id_idx");
    expect(names).toContain("listing_imports_store_id_status_idx");
    expect(names).not.toContain("listing_imports_store_id_idx");
    const createdBy = rows.find((row) => row.indexname === "listing_imports_created_by_id_idx");
    const storeStatus = rows.find((row) => row.indexname === "listing_imports_store_id_status_idx");
    expect(createdBy?.indexdef).toMatch(/\(created_by_id\)/);
    expect(storeStatus?.indexdef).toMatch(/\(store_id, status\)/);
    const storeOnly = rows.filter((row) => /\(store_id\)\s*$/.test(row.indexdef));
    expect(storeOnly).toEqual([]);
  });
});

const DRIFT_TABLES = [
  "accounts",
  "audit_logs",
  "categories",
  "listings",
  "master_products",
  "product_synonyms",
  "sessions",
  "store_banners",
  "store_collections",
  "stores",
  "two_factors",
];

describe.skipIf(!connectionString)("listing_imports index matches the live lane", () => {
  it("the migrated database has the created_by index and no store_id-only index", async () => {
    const client = new Client({ connectionString });
    await client.connect();
    try {
      const { rows } = await client.query<{ indexname: string; indexdef: string }>(
        `SELECT indexname, indexdef
         FROM pg_indexes
         WHERE schemaname = 'public' AND tablename = 'listing_imports'`,
      );
      const names = rows.map((row) => row.indexname);
      expect(names).toContain("listing_imports_created_by_id_idx");
      expect(names).toContain("listing_imports_store_id_status_idx");
      expect(names).not.toContain("listing_imports_store_id_idx");
    } finally {
      await client.end();
    }
  });

  it("migrate diff changes none of listing_imports and still drifts on the other 11 tables", async () => {
    const prismaCli = path.resolve(__dirname, "../../../node_modules/prisma/build/index.js");
    const { stdout } = await execFileAsync(
      process.execPath,
      [prismaCli, "migrate", "diff", "--from-config-datasource", "--to-schema", "prisma/schema.prisma", "--script"],
      { cwd: path.resolve(__dirname, "../../.."), env: process.env, maxBuffer: 10 * 1024 * 1024 },
    );
    expect(stdout).not.toMatch(/listing_imports/);
    for (const table of DRIFT_TABLES) {
      expect(stdout).toContain(table);
    }
  }, 60_000);
});
