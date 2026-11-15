import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";

// Replays the fee ledger migration on a scratch schema with RLS enabled and forced, as the
// migrating role (app_owner on lanes and CI, neither superuser nor BYPASSRLS). Rows are seeded and
// read back as app_user with platform-admin visibility; nothing disables RLS.

const MIGRATIONS = path.resolve(__dirname, "../../../prisma/migrations");
const TARGET = "20261116200000_platform_fee_ledger";
const SCHEMA = `tmp_fee546_${process.pid}`;
// Shared with the other scratch-schema replays: concurrent CREATE in public collides.
const REPLAY_LOCK = 199031030;
const connectionString = process.env.DIRECT_URL ?? process.env.DATABASE_URL;

/*
 * Orders made before the migration, store s1 (all succeeded refunds 5400, all captures 11000):
 * o1 completed, captured 2000, Ready 2030-01-10.
 * o2 partly refunded, captured 3000, Ready 2030-01-11; refund 1000 succeeded 2030-01-12, one failed refund of 500.
 * o3 fully refunded, captured 1500, Ready 2030-01-13; refund 1500 succeeded 2030-01-14.
 * o4 capture first seen at cancel and refunded in full: capture cleared, refund 2500 succeeded, cancelled 2030-01-15.
 * o5 cancel refund failed, then resolved by hand: capture cleared, refund 400 succeeded, refund_failed 2030-01-16,
 *    refund_resolved_manually 2030-01-20 with capturedCents 1000 and repaidCents 600, cancelled_at moved to 2030-01-20.
 * o6 cancel refund failed and not resolved: Refund failed, captured 1000, no Ready or cancelled time, refund_failed 2030-01-17.
 * o7 cancelled before capture: nothing captured, no refunds.
 */
const SEED = `
  INSERT INTO stores (id, slug, name, updated_at) VALUES ('s1', 's1', 'S1', now());
  INSERT INTO users (id, name, email, updated_at) VALUES ('u1', 'Admin', 'admin@example.com', now());
  INSERT INTO customers (id, store_id, name, updated_at) VALUES ('c1', 's1', 'C1', now());
  INSERT INTO orders (id, store_id, number, customer_id, subtotal_cents, buffer_cents, total_authorized_cents,
                      status, captured_amount_cents, ready_at, cancelled_at, updated_at) VALUES
    ('o1', 's1', 1, 'c1', 0, 0, 5000, 'COMPLETED', 2000, '2030-01-10 12:00', NULL, now()),
    ('o2', 's1', 2, 'c1', 0, 0, 5000, 'PARTIALLY_REFUNDED', 3000, '2030-01-11 12:00', NULL, now()),
    ('o3', 's1', 3, 'c1', 0, 0, 5000, 'REFUNDED', 1500, '2030-01-13 12:00', NULL, now()),
    ('o4', 's1', 4, 'c1', 0, 0, 5000, 'CANCELLED', NULL, NULL, '2030-01-15 12:00', now()),
    ('o5', 's1', 5, 'c1', 0, 0, 5000, 'CANCELLED', NULL, NULL, '2030-01-20 12:00', now()),
    ('o6', 's1', 6, 'c1', 0, 0, 5000, 'REFUND_FAILED', 1000, NULL, NULL, now()),
    ('o7', 's1', 7, 'c1', 0, 0, 5000, 'CANCELLED', NULL, NULL, '2030-01-18 12:00', now());
  INSERT INTO refund_requests (id, store_id, order_id, payment_intent_id, key, amount_cents, refund_application_fee,
                               state, provider_status, created_at) VALUES
    ('r2', 's1', 'o2', 'pi2', 'k2', 1000, true, 'CREATED', 'succeeded', '2030-01-12 12:00'),
    ('r2f', 's1', 'o2', 'pi2', 'k2f', 500, true, 'CREATED', 'failed', '2030-01-12 13:00'),
    ('r3', 's1', 'o3', 'pi3', 'k3', 1500, true, 'CREATED', 'succeeded', '2030-01-14 12:00'),
    ('r4', 's1', 'o4', 'pi4', 'k4', 2500, true, 'CREATED', 'succeeded', '2030-01-15 11:00'),
    ('r5', 's1', 'o5', 'pi5', 'k5', 400, true, 'CREATED', 'succeeded', '2030-01-16 10:00');
  INSERT INTO audit_logs (id, store_id, actor_id, actor_email, action, entity_type, entity_id, after, created_at) VALUES
    ('a5f', 's1', 'u1', 'admin@example.com', 'refund_failed', 'order', 'o5', '{"refundId":"re5"}', '2030-01-16 11:00'),
    ('a5m', 's1', 'u1', 'admin@example.com', 'refund_resolved_manually', 'order', 'o5',
     '{"repaidCents":600,"capturedCents":1000,"refundedCents":400}', '2030-01-20 12:00'),
    ('a6f', 's1', 'u1', 'admin@example.com', 'refund_failed', 'order', 'o6', '{"refundId":"re6"}', '2030-01-17 12:00');
`;

describe.skipIf(!connectionString)("platform fee ledger migration backfill", () => {
  const client = new Client({ connectionString });

  async function asAdmin<T>(sql: string): Promise<T[]> {
    await client.query("BEGIN");
    try {
      await client.query("SET LOCAL ROLE app_user");
      await client.query("SELECT set_config('app.is_platform_admin', 'true', true)");
      return (await client.query(sql)).rows as T[];
    } finally {
      await client.query("ROLLBACK");
    }
  }

  let refundsBefore = 0;

  beforeAll(async () => {
    await client.connect();
    await client.query("SELECT pg_advisory_lock($1)", [REPLAY_LOCK]);
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await client.query(`CREATE SCHEMA ${SCHEMA}`);
      await client.query(`GRANT USAGE ON SCHEMA ${SCHEMA} TO app_user`);
      await client.query(`SET search_path = ${SCHEMA}, public`);
      const dirs = fs.readdirSync(MIGRATIONS).filter((d) => /^\d/.test(d) && d < TARGET).sort();
      for (const d of dirs) await client.query(fs.readFileSync(path.join(MIGRATIONS, d, "migration.sql"), "utf8"));
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.is_platform_admin', 'true', true)");
      await client.query(SEED);
      await client.query("COMMIT");
      refundsBefore = (await asAdmin<{ n: number }>(
        "SELECT SUM(amount_cents)::int AS n FROM refund_requests WHERE provider_status = 'succeeded'",
      ))[0].n;
      await client.query("SELECT set_config('app.is_platform_admin', '', false)");
      await client.query(fs.readFileSync(path.join(MIGRATIONS, TARGET, "migration.sql"), "utf8"));
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [REPLAY_LOCK]);
    }
  }, 180_000);

  afterAll(async () => {
    await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await client.end();
  });

  it("keeps RLS forced on the tables it backfills", async () => {
    const { rows } = await client.query(
      `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND relname IN ('orders', 'refund_requests') ORDER BY relname`,
      [SCHEMA],
    );
    expect(rows.every((r) => r.relrowsecurity && r.relforcerowsecurity)).toBe(true);
    expect(rows).toHaveLength(2);
  });

  it("dates every historical succeeded refund, so refund totals match before and after", async () => {
    const rows = await asAdmin<{ id: string; at: string | null }>(
      "SELECT id, to_char(succeeded_at, 'YYYY-MM-DD HH24:MI') AS at FROM refund_requests ORDER BY id",
    );
    expect(rows.map((r) => [r.id, r.at])).toEqual([
      ["r2", "2030-01-12 12:00"],
      ["r2f", null],
      ["r3", "2030-01-14 12:00"],
      ["r4", "2030-01-15 11:00"],
      ["r5", "2030-01-16 10:00"],
    ]);
    const after = await asAdmin<{ n: number }>(
      "SELECT SUM(amount_cents)::int AS n FROM refund_requests WHERE succeeded_at IS NOT NULL",
    );
    expect(refundsBefore).toBe(5400);
    expect(after[0].n).toBe(refundsBefore);
  });

  it("records every historical capture once, including cleared and failed-refund captures", async () => {
    const rows = await asAdmin<{ id: string; confirmed_capture_cents: number | null; at: string | null }>(
      "SELECT id, confirmed_capture_cents, to_char(capture_confirmed_at, 'YYYY-MM-DD HH24:MI') AS at FROM orders ORDER BY id",
    );
    expect(rows.map((r) => [r.id, r.confirmed_capture_cents, r.at])).toEqual([
      ["o1", 2000, "2030-01-10 12:00"],
      ["o2", 3000, "2030-01-11 12:00"],
      ["o3", 1500, "2030-01-13 12:00"],
      ["o4", 2500, "2030-01-15 12:00"],
      ["o5", 1000, "2030-01-16 11:00"],
      ["o6", 1000, "2030-01-17 12:00"],
      ["o7", null, null],
    ]);
    const total = rows.reduce((sum, r) => sum + (r.confirmed_capture_cents ?? 0), 0);
    expect(total).toBe(2000 + 3000 + 1500 + 2500 + 1000 + 1000);
  });

  it("leaves the platform-admin setting cleared", async () => {
    const { rows } = await client.query("SELECT current_setting('app.is_platform_admin', true) AS v");
    expect(rows[0].v ?? "").toBe("");
  });
});
