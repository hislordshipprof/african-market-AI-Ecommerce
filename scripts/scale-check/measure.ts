/**
 * #578 scale check: times the six named paths on the seeded lane database and prints their EXPLAIN plans as Markdown.
 * Run through run.sh (which refuses any non-local database) after `run.sh seed`. Email goes to the in-memory test
 * sender (NODE_ENV=test), so cron timings are database and compute only; Resend latency is added in the report.
 */
import { writeFileSync } from "node:fs";
import { PrismaClient, Prisma } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { runtimeDatabaseUrl } from "../../src/lib/env";

type Logged = { query: string; params: string; duration: number };
const log: Logged[] = [];
let recording = false;

// db.ts reuses a client already on globalThis; this one logs every query so the cron steps can be broken down.
const pool = new Pool({ connectionString: runtimeDatabaseUrl(process.env) });
pool.on("connect", (client) => void client.query("SET TIME ZONE 'UTC'"));
const client = new PrismaClient({ adapter: new PrismaPg(pool, { disposeExternalPool: true }), log: [{ emit: "event", level: "query" }] });
client.$on("query", (e) => { if (recording) log.push({ query: e.query, params: e.params, duration: e.duration }); });
(globalThis as unknown as { prisma: PrismaClient }).prisma = client;

const out: string[] = [];
const say = (line = "") => { out.push(line); console.log(line); };
const ms = (n: number) => `${Math.round(n)} ms`;

async function asAdmin<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>, storeId?: string): Promise<T> {
  return client.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL ROLE app_user`;
    // A store id reads as that store does, under its RLS policy; without one, as a platform admin.
    if (storeId) await tx.$executeRaw`SELECT set_config('app.store_id', ${storeId}, true)`;
    else await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
    return fn(tx);
  }, { timeout: 300_000 });
}

async function explain(title: string, sql: Prisma.Sql, storeId?: string) {
  const rows = await asAdmin((tx) => tx.$queryRaw<Array<{ "QUERY PLAN": string }>>`EXPLAIN (ANALYZE, BUFFERS) ${sql}`, storeId);
  say(`<details><summary>${title}</summary>\n\n\`\`\`\n${rows.map((r) => r["QUERY PLAN"]).join("\n")}\n\`\`\`\n</details>\n`);
}

/** Warm once, then the median of three runs. */
async function timed<T>(fn: () => Promise<T>): Promise<{ median: number; result: T }> {
  let result = await fn();
  const runs: number[] = [];
  for (let i = 0; i < 3; i++) {
    const started = performance.now();
    result = await fn();
    runs.push(performance.now() - started);
  }
  return { median: runs.sort((a, b) => a - b)[1], result };
}

/** The step's queries grouped by text, slowest total first, with an EXPLAIN of the top three. */
async function breakdown(label: string, queries: Logged[]) {
  const groups = new Map<string, { count: number; total: number; params: string; storeId?: string; admin: boolean }>();
  let storeId: string | undefined;
  let admin = false;
  for (const q of queries) {
    const text = q.query.trim();
    if (text.startsWith("BEGIN")) { storeId = undefined; admin = false; }
    if (text.includes("'app.store_id'")) storeId = (JSON.parse(q.params) as string[])[0];
    if (text.includes("'app.is_platform_admin'")) admin = true;
    if (/^(BEGIN|COMMIT|SET LOCAL|SELECT set_config)/.test(text)) continue;
    const g = groups.get(q.query) ?? { count: 0, total: 0, params: q.params, storeId, admin };
    g.count += 1;
    g.total += q.duration;
    groups.set(q.query, g);
  }
  const top = [...groups.entries()].sort((a, b) => b[1].total - a[1].total).slice(0, 5);
  say(`${label}: ${queries.length} statements in all (${groups.size} distinct). Slowest by total time:`);
  say();
  say("| Query (start) | Calls | Total | Mean |");
  say("|---|---:|---:|---:|");
  for (const [query, g] of top) {
    say(`| \`${query.replace(/\s+/g, " ").slice(0, 90).replace(/\|/g, "\\|")}…\` | ${g.count} | ${ms(g.total)} | ${(g.total / g.count).toFixed(1)} ms |`);
  }
  say();
  for (const [query, g] of top.slice(0, 3)) {
    const params = JSON.parse(g.params) as unknown[];
    try {
      const rows = await asAdmin((tx) => tx.$queryRawUnsafe<Array<{ "QUERY PLAN": string }>>(`EXPLAIN (ANALYZE, BUFFERS) ${query}`, ...params), g.admin ? undefined : g.storeId);
      say(`<details><summary>${label}: ${query.replace(/\s+/g, " ").slice(0, 70)}…</summary>\n\n\`\`\`\n${rows.map((r) => r["QUERY PLAN"]).join("\n")}\n\`\`\`\n</details>\n`);
    } catch (err) {
      say(`(EXPLAIN skipped for one query: ${err instanceof Error ? err.message.split("\n")[0] : String(err)})`);
    }
  }
}

async function main() {
  const { searchOrders, listOrderSearchStores } = await import("../../src/lib/admin/order-search-query");
  const { parseOrderSearch } = await import("../../src/lib/admin/order-search");
  const { orderSearchSql, listSubscriptionOverviewRows, platformAdminTransaction, findCourierIncidentRows } = await import("../../src/lib/db");
  const { findCourierIncidents } = await import("../../src/lib/admin/courier-incidents-query");
  const { platformFeeLedger, captureFactsSql, refundFactsSql, repaymentFactsSql } = await import("../../src/lib/admin/fee-ledger-query");
  const { ledgerMonth } = await import("../../src/lib/admin/fee-ledger");
  const { subscriptionTotals } = await import("../../src/lib/admin/subscriptions");
  const { runDigestPage } = await import("../../src/lib/copilot/digest");
  const { runWeeklyPage } = await import("../../src/lib/copilot/weekly-report");

  const counts = await asAdmin((tx) => tx.$queryRaw<Array<Record<string, bigint>>>`
    SELECT (SELECT count(*) FROM stores WHERE id LIKE 'scale578-%') AS stores,
           (SELECT count(*) FROM listings WHERE store_id LIKE 'scale578-%') AS listings,
           (SELECT count(*) FROM orders WHERE store_id LIKE 'scale578-%') AS orders,
           (SELECT count(*) FROM order_lines WHERE store_id LIKE 'scale578-%') AS order_lines,
           (SELECT count(*) FROM stock_events WHERE store_id LIKE 'scale578-%') AS stock_events,
           (SELECT count(*) FROM delivery_events WHERE store_id LIKE 'scale578-%') AS delivery_events,
           (SELECT count(*) FROM refund_requests WHERE store_id LIKE 'scale578-%') AS refunds`);
  say("## Seed");
  say();
  say(Object.entries(counts[0]).map(([k, v]) => `${k.replace("_", " ")}: ${Number(v).toLocaleString("en-US")}`).join(" · "));
  say();

  const pages: Array<{ path: string; target: number; ms: number }> = [];
  const store = "scale578-s042";
  const filtersOf = (input: Record<string, string>) => {
    const parsed = parseOrderSearch(input);
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.filters;
  };

  say("## Orders search (/admin/orders/search)");
  say();
  const storeList = await timed(() => listOrderSearchStores());
  say(`- Store list for the form: ${storeList.result.length} stores, ${ms(storeList.median)}`);
  pages.push({ path: "Orders search: store list", target: 2000, ms: storeList.median });
  const cases: Array<[string, Record<string, string>]> = [
    ["store, newest page", { storeId: store }],
    ["store plus order number", { storeId: store, number: "1500" }],
    ["exact email across stores", { email: "scale578-42-77@example.com" }],
    ["exact phone across stores", { phone: "+15550420077" }],
    ["status across stores", { status: "REFUND_FAILED" }],
    ["fulfillment and date range across stores", { fulfillment: "courier", from: "2026-10-20", to: "2026-10-21" }],
  ];
  for (const [name, input] of cases) {
    const run = await timed(() => searchOrders(filtersOf(input)));
    say(`- ${name}: ${run.result.rows.length} rows, ${ms(run.median)}`);
    pages.push({ path: `Orders search: ${name}`, target: 1000, ms: run.median });
  }
  say();
  for (const [name, input] of cases) await explain(`Plan: ${name}`, orderSearchSql(filtersOf(input), 51));

  say("## Courier incident log (/admin/couriers/incidents)");
  say();
  const incidentCases: Array<[string, Parameters<typeof findCourierIncidents>[1]]> = [
    ["first page, no filter", {}],
    ["one store", { storeId: store }],
    ["kind: assigned late", { kind: "assigned_late" }],
    ["date range, two days", { from: "2026-10-20", to: "2026-10-21" }],
  ];
  for (const [name, filters] of incidentCases) {
    const run = await timed(() => platformAdminTransaction((tx) => findCourierIncidents(tx, filters), { timeout: 120_000 }));
    say(`- ${name}: ${run.result.rows.length} rows, ${ms(run.median)}`);
    pages.push({ path: `Incident log: ${name}`, target: 2000, ms: run.median });
  }
  say();
  for (const [name, filters] of incidentCases.slice(0, 2)) {
    // Runs the log's own query with EXPLAIN in front of it.
    const explaining = (tx: Prisma.TransactionClient) => ({
      $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) =>
        tx.$queryRaw`EXPLAIN (ANALYZE, BUFFERS) ${Prisma.sql(strings, ...values)}`,
    });
    const rows = await asAdmin((tx) => findCourierIncidentRows(explaining(tx) as never, {
      storeId: filters.storeId, kind: filters.kind, limit: 51,
    }) as unknown as Promise<Array<{ "QUERY PLAN": string }>>);
    say(`<details><summary>Plan: ${name}</summary>\n\n\`\`\`\n${rows.map((r) => r["QUERY PLAN"]).join("\n")}\n\`\`\`\n</details>\n`);
  }

  say("## Fee ledger (/admin/billing/ledger)");
  say();
  const ledger = await timed(() => platformFeeLedger("2026-10"));
  say(`- October 2026: ${ledger.result.total.orders.toLocaleString("en-US")} captured orders, ${ledger.result.rows.length.toLocaleString("en-US")} rows, ${ledger.result.stores.length} stores, ${ms(ledger.median)}`);
  pages.push({ path: "Fee ledger: October 2026", target: 2000, ms: ledger.median });
  say();
  const month = ledgerMonth("2026-10");
  await explain("Plan: captures", captureFactsSql(month));
  await explain("Plan: refunds", refundFactsSql(month));
  await explain("Plan: manual repayments", repaymentFactsSql(month));

  say("## Subscriptions list (/admin/billing/subscriptions)");
  say();
  const loadSubs = async () => subscriptionTotals(await listSubscriptionOverviewRows());
  recording = true;
  log.length = 0;
  await loadSubs();
  recording = false;
  const subsQueries = log.splice(0);
  const subs = await timed(loadSubs);
  say(`- ${subs.result.stores} stores, MRR ${(subs.result.mrrCents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })}, ${ms(subs.median)}`);
  pages.push({ path: "Subscriptions list", target: 2000, ms: subs.median });
  say();
  await breakdown("Subscriptions", subsQueries);

  const resetClaims = () => asAdmin(async (tx) => {
    await tx.$executeRaw`DELETE FROM copilot_digests WHERE store_id LIKE 'scale578-%'`;
    await tx.$executeRaw`DELETE FROM copilot_weekly_reports WHERE store_id LIKE 'scale578-%'`;
  });

  const steps: Array<{ path: string; ms: number; due: number; statements: number }> = [];
  async function cronRun(name: string, nowIso: string, page: typeof runDigestPage | typeof runWeeklyPage) {
    say(`## ${name}`);
    say();
    await resetClaims();
    let cursor: string | null = null;
    let n = 0;
    do {
      recording = true;
      log.length = 0;
      const started = performance.now();
      const result: Awaited<ReturnType<typeof runDigestPage>> = await page(cursor, nowIso, { ...process.env, BETTER_AUTH_URL: "https://example.com" });
      const elapsed = performance.now() - started;
      recording = false;
      steps.push({ path: `${name} step ${n}`, ms: elapsed, due: result.due, statements: log.length });
      say(`- Step ${n}: ${result.due} stores due, ${result.sent} sent, ${result.failedStoreIds.length} failed, ${ms(elapsed)}, ${log.length} statements`);
      if (n === 0) {
        say();
        await breakdown(`${name} step 0`, [...log]);
      }
      cursor = result.nextCursor;
      n += 1;
    } while (cursor);
    say();
  }
  // 20:00 in New York on Friday 30 October (EDT), and on Monday 26 October for the weekly report.
  await cronRun("Daily digest (copilot/daily-digest)", "2026-10-31T00:00:00.000Z", runDigestPage);
  await cronRun("Weekly report (copilot/weekly-report)", "2026-10-27T00:00:00.000Z", runWeeklyPage);
  await resetClaims();

  say("## Summary");
  say();
  say("| Path | Target | Measured | |");
  say("|---|---:|---:|---|");
  for (const p of pages) say(`| ${p.path} | ${ms(p.target)} | ${ms(p.ms)} | ${p.ms < p.target ? "pass" : "FAIL"} |`);
  for (const s of steps) say(`| ${s.path} (${s.due} due, ${s.statements} statements) | 120,000 ms | ${ms(s.ms)} | ${s.ms < 120_000 ? "pass" : "FAIL"} |`);

  const file = process.argv[2];
  if (file) writeFileSync(file, `${out.join("\n")}\n`);
  await client.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await client.$disconnect();
  process.exit(1);
});
