import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveDirectUrl } from "../env";

// Replays every migration into a scratch schema with orders RLS still forced,
// as the migrating role (app_owner on lanes and CI). Rows that existed before #537 are seeded
// just before 20261116190000_order_capture_record, then read back as app_user with platform-admin visibility.

const MIGRATIONS = path.resolve(__dirname, "../../../prisma/migrations");
const CAPTURE_MIGRATION = "20261116190000_order_capture_record";
const SCHEMA = `tmp_t537_capture_${process.pid}`;
const REPLAY_LOCK = 199031030;
const READY_AT = "2026-03-10 15:40:00";
const REPAID_READY_AT = "2026-03-11 14:30:00";

let directUrl: string | undefined;
try {
  directUrl = resolveDirectUrl() || undefined;
} catch {
  directUrl = undefined;
}

type CaptureRow = { id: string; capture_cents: number | null; captured_at: string | null };

function seedSql(): string {
  const order = (id: string, store: string, number: number, status: string, captured: number | null, readyAt: string | null) =>
    `('${id}', '${store}', ${number}, 'cust-${store}', '${status}', 6000, 0, 6000, ${captured ?? "NULL"}, ${readyAt ? `TIMESTAMP '${readyAt}'` : "NULL"})`;
  return `
    INSERT INTO stores (id, slug, name, updated_at) VALUES
      ('store-a', 'store-a', 'Store A', now()), ('store-b', 'store-b', 'Store B', now());
    INSERT INTO users (id, name, email, updated_at) VALUES ('admin-1', 'Admin', 'admin@example.com', now());
    INSERT INTO customers (id, store_id, name, updated_at) VALUES
      ('cust-store-a', 'store-a', 'Ada', now()), ('cust-store-b', 'store-b', 'Bo', now());
    INSERT INTO orders (id, store_id, number, customer_id, status, subtotal_cents, buffer_cents,
                        total_authorized_cents, captured_amount_cents, ready_at) VALUES
      ${order("o-captured", "store-a", 1, "COMPLETED", 3795, READY_AT)},
      ${order("o-other-store", "store-b", 1, "READY_FOR_PICKUP", 1000, READY_AT)},
      ${order("o-capturing", "store-a", 2, "CAPTURING", 4000, null)},
      ${order("o-repaid", "store-a", 3, "CANCELLED", null, REPAID_READY_AT)},
      ${order("o-anomaly", "store-a", 4, "CANCELLED", null, null)},
      ${order("o-ready-unknown", "store-a", 5, "CANCELLED", null, READY_AT)},
      ${order("o-never", "store-a", 6, "AUTHORIZED", null, null)};
    INSERT INTO audit_logs (id, store_id, actor_id, actor_email, action, entity_type, entity_id, after) VALUES
      ('a-repaid', 'store-a', 'admin-1', 'admin@example.com', 'refund_resolved_manually', 'order', 'o-repaid',
       '{"capturedCents": 2849, "repaidCents": 2849}'),
      ('a-anomaly', 'store-a', 'admin-1', 'admin@example.com', 'anomaly_refund', 'order', 'o-anomaly',
       '{"refundId": "re_1", "amountRefunded": 5500}');
  `;
}

describe.skipIf(!directUrl)("order capture record backfill under forced RLS", () => {
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
      const dirs = fs.readdirSync(MIGRATIONS).filter((dir) => /^\d/.test(dir)).sort();
      for (const dir of dirs) {
        if (dir === CAPTURE_MIGRATION) {
          await client.query("BEGIN");
          await client.query("SELECT set_config('app.is_platform_admin', 'true', true)");
          await client.query(seedSql());
          await client.query("COMMIT");
        }
        await client.query(fs.readFileSync(path.join(MIGRATIONS, dir, "migration.sql"), "utf8"));
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
    const orders = await client.query<{ relforcerowsecurity: boolean }>(
      `SELECT relforcerowsecurity FROM pg_class WHERE relname = 'orders' AND relnamespace = $1::regnamespace`,
      [SCHEMA],
    );
    expect(orders.rows).toEqual([{ relforcerowsecurity: true }]);
    const visible = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM orders");
    expect(visible.rows[0]!.n).toBe(0);
  });

  it("orders captured before #537 get their capture record in every store; intended amounts and uncaptured orders stay empty", async () => {
    const rows = await asAdminUser(() =>
      client.query<CaptureRow>(
        `SELECT id, capture_cents, to_char(captured_at, 'YYYY-MM-DD HH24:MI:SS') AS captured_at FROM orders ORDER BY id COLLATE "C"`,
      ),
    );
    expect(rows.rows).toEqual([
      { id: "o-anomaly", capture_cents: 5500, captured_at: null },
      { id: "o-captured", capture_cents: 3795, captured_at: READY_AT },
      { id: "o-capturing", capture_cents: null, captured_at: null },
      { id: "o-never", capture_cents: null, captured_at: null },
      { id: "o-other-store", capture_cents: 1000, captured_at: READY_AT },
      { id: "o-ready-unknown", capture_cents: null, captured_at: READY_AT },
      { id: "o-repaid", capture_cents: 2849, captured_at: REPAID_READY_AT },
    ]);
  });
});
