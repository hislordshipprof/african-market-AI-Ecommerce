import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";

const execFileAsync = promisify(execFile);

const MIGRATIONS = path.resolve(__dirname, "../../../prisma/migrations");
const TARGET = "20261104160000_listing_variant_weight_placeholder";
const SCHEMA = "tmp_weight_placeholder_216";
const connectionString = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
// Shared with the other scratch replays. Concurrent CREATE in public raises
// "tuple concurrently updated" when both scratch schemas replay at once.
const REPLAY_LOCK = 199031030;

// Replays every migration into an empty scratch schema (an empty database).
// listing_variants has forced row-level security. ADD COLUMN … DEFAULT false does
// not UPDATE rows: Postgres stores a non-volatile default in the table metadata,
// and the migrating role (DIRECT_URL, the table owner) applies it. A later
// app_user connection would not be able to backfill hidden rows. This test
// disables RLS on the scratch tables only so the pre-migration insert can land;
// it never edits an applied migration.

describe.skipIf(!connectionString)("weight_placeholder column migration", () => {
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
        if (dir === TARGET) {
          for (const table of ["stores", "listings", "listing_variants"]) {
            await client.query(`ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY`);
          }
          await client.query(
            `INSERT INTO stores (id, slug, name, updated_at) VALUES ('s216', 's216', 'S216', now())`,
          );
          await client.query(
            `INSERT INTO listings (id, store_id, price, stock_mode, updated_at)
             VALUES ('l216', 's216', 100, 'counted', now())`,
          );
          await client.query(
            `INSERT INTO listing_variants (id, listing_id, label, price, weight_g, updated_at)
             VALUES ('v216', 'l216', 'Default', 100, 100, now())`,
          );
        }
        await client.query(fs.readFileSync(path.join(MIGRATIONS, dir, "migration.sql"), "utf8"));
      }
      await client.query(`ALTER TABLE listing_variants DISABLE ROW LEVEL SECURITY`);
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [REPLAY_LOCK]);
    }
  }, 120_000);

  afterAll(async () => {
    await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await client.end();
  });

  it("replaying migrations adds weight_placeholder NOT NULL DEFAULT false and existing rows read false", async () => {
    const { rows } = await client.query<{
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>(
      `SELECT data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = $1
         AND table_name = 'listing_variants'
         AND column_name = 'weight_placeholder'`,
      [SCHEMA],
    );
    expect(rows).toEqual([
      { data_type: "boolean", is_nullable: "NO", column_default: "false" },
    ]);
    const existing = await client.query<{ weight_placeholder: boolean }>(
      `SELECT weight_placeholder FROM listing_variants WHERE id = 'v216'`,
    );
    expect(existing.rows).toEqual([{ weight_placeholder: false }]);
  });

  it("inserts that omit weight_placeholder read false", async () => {
    await client.query(
      `INSERT INTO listing_variants (id, listing_id, label, price, weight_g, updated_at)
       VALUES ('v216b', 'l216', 'Omit', 250, 500, now())`,
    );
    const { rows } = await client.query<{ weight_placeholder: boolean }>(
      `SELECT weight_placeholder FROM listing_variants WHERE id = 'v216b'`,
    );
    expect(rows).toEqual([{ weight_placeholder: false }]);
  });
});

describe.skipIf(!connectionString)("weight_placeholder matches the live lane", () => {
  it("migrate diff from the lane database shows no listing_variants drift", async () => {
    const prismaCli = path.resolve(__dirname, "../../../node_modules/prisma/build/index.js");
    const { stdout } = await execFileAsync(
      process.execPath,
      [prismaCli, "migrate", "diff", "--from-config-datasource", "--to-schema", "prisma/schema.prisma", "--script"],
      { cwd: path.resolve(__dirname, "../../.."), env: process.env, maxBuffer: 10 * 1024 * 1024 },
    );
    expect(stdout).not.toMatch(/listing_variants/);
    expect(stdout).not.toMatch(/weight_placeholder/);
  }, 60_000);
});
