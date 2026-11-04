import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";

const MIGRATIONS = path.resolve(__dirname, "../../../prisma/migrations");
const SCHEMA = "tmp_cart_sub_221";
const connectionString = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
// Shared with the other scratch-schema replays. Concurrent CREATE in public raises
// "tuple concurrently updated" when two replays run at once.
const REPLAY_LOCK = 199031030;
const INDEX = "cart_lines_substitute_variant_id_idx";

describe.skipIf(!connectionString)("cart_lines substitute variant index migration", () => {
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

  it("indexes cart_lines.substitute_variant_id on an empty database", async () => {
    const { rows } = await client.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
       WHERE schemaname = $1 AND tablename = 'cart_lines' AND indexname = $2`,
      [SCHEMA, INDEX],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.indexdef).toMatch(/\(substitute_variant_id\)/);
  });
});

describe.skipIf(!connectionString)("cart_lines substitute variant index on the lane", () => {
  it("the migrated database indexes cart_lines.substitute_variant_id", async () => {
    const client = new Client({ connectionString });
    await client.connect();
    try {
      const { rows } = await client.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes
         WHERE schemaname = 'public' AND tablename = 'cart_lines' AND indexname = $1`,
        [INDEX],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.indexdef).toMatch(/\(substitute_variant_id\)/);
    } finally {
      await client.end();
    }
  });
});
