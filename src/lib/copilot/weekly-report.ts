import { resolveAuthBaseUrl } from "../auth";
import { CANCEL_REASON_LABELS, customersView, operationsView, productsView, salesRows, salesView } from "../analytics/queries";
import type { AnalyticsRange } from "../analytics/range";
import { Prisma, platform, storeScoped, storeScopedRawQuery, storeScopedTransaction } from "../db";
import { sendEmail } from "../email/send";
import { money } from "../format";
import { inngest } from "../inngest/client";
import { escapeHtml } from "../notifications/messages";
import { isValidTimezone } from "../order/store-hours";
import { localClock } from "./digest";
import { inventoryReport, RUNNING_OUT_DAYS, storeWeek } from "./inventory-report";

/**
 * The owner's Monday email about the store week just ended (#550): template text from the #498 analytics
 * queries and the #549 stock estimate, with no model call. Both plans get it, like the daily digest.
 */
const STORES_PER_PAGE = 100;
const TOP_SELLERS = 10;
const MOVERS = 5;
export const REPORTS_SHOWN = 8;
/** A claim older than this is from a run that died mid-send; the next run may take it. */
const CLAIM_STALE_MS = 5 * 60_000;
const MONDAY = 1;

export interface ReportWeek {
  /** ISO week of the store week reported, e.g. 2026-W46. */
  isoWeek: string;
  from: string;
  to: string;
  priorFrom: string;
  priorTo: string;
}

function addDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** The ISO week named by its Thursday: the year and week number that Thursday falls in. */
function isoWeekOf(monday: string): string {
  const thursday = new Date(`${addDays(monday, 3)}T00:00:00Z`);
  const year = thursday.getUTCFullYear();
  const week = Math.floor((thursday.getTime() - Date.UTC(year, 0, 1)) / 86_400_000 / 7) + 1;
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/** The last full store week, Monday to Sunday in the store's zone, and the week before it. */
export function reportWeek(timeZone: string, now: Date): ReportWeek {
  const from = addDays(storeWeek(timeZone, now), -7);
  return { isoWeek: isoWeekOf(from), from, to: addDays(from, 6), priorFrom: addDays(from, -7), priorTo: addDays(from, -1) };
}

export interface WeeklyFigures {
  from: string;
  to: string;
  sales: { goodsCents: number; orders: number; priorGoodsCents: number; priorOrders: number; refundsCents: number };
  topSellers: Array<{ name: string; units: number }>;
  moversUp: Array<{ name: string; units: number; priorUnits: number }>;
  moversDown: Array<{ name: string; units: number; priorUnits: number }>;
  runningOutSoon: Array<{ name: string; qty: number | null; daysLeft: number; outDay: string }>;
  shorts: Array<{ name: string; shortLines: number; swappedLines: number }>;
  issues: Array<{ reason: string; reports: number; refundedCents: number }>;
  cancellations: Array<{ reason: string; orders: number }>;
  swaps: { answered: number; timedOut: number };
  repeat: { shoppers: number; repeatShoppers: number; repeatRatePct: number };
}

const ISSUE_LABELS: Record<string, string> = {
  missing: "Missing",
  damaged: "Damaged",
  wrong: "Wrong item",
  poor_freshness: "Not fresh",
};

async function issueReasons(storeId: string, range: AnalyticsRange, timeZone: string) {
  const rows = await storeScopedRawQuery<{ type: string; reports: number; refundedCents: number }>(storeId, Prisma.sql`
    SELECT i.type, COUNT(*)::int AS reports,
           COALESCE(SUM(i.amount_cents) FILTER (WHERE i.state IN ('auto_refunded', 'approved')), 0)::int AS "refundedCents"
    FROM issue_reports i
    WHERE i.store_id = ${storeId}
      AND i.created_at >= ((${range.from}::date)::timestamp AT TIME ZONE ${timeZone}) AT TIME ZONE 'UTC'
      AND i.created_at < (((${range.to}::date + 1))::timestamp AT TIME ZONE ${timeZone}) AT TIME ZONE 'UTC'
    GROUP BY i.type
    ORDER BY reports DESC, i.type`);
  return rows.map((row) => ({ reason: ISSUE_LABELS[row.type] ?? row.type, reports: row.reports, refundedCents: row.refundedCents }));
}

/** The week's figures, read under the store's RLS. Store days run midnight to midnight in the store's zone. */
export async function weeklyFigures(storeId: string, timeZone: string, now: Date): Promise<WeeklyFigures> {
  const week = reportWeek(timeZone, now);
  const range: AnalyticsRange = { preset: "custom", from: week.from, to: week.to };
  const prior: AnalyticsRange = { preset: "custom", from: week.priorFrom, to: week.priorTo };
  const [sales, priorSales, products, priorProducts, customers, operations, issues, stock] = await Promise.all([
    salesRows(storeId, range, timeZone).then((rows) => salesView(rows, range).totals),
    salesRows(storeId, prior, timeZone).then((rows) => salesView(rows, prior).totals),
    productsView(storeId, range, timeZone),
    productsView(storeId, prior, timeZone),
    customersView(storeId, range, timeZone),
    operationsView(storeId, range, timeZone),
    issueReasons(storeId, range, timeZone),
    inventoryReport(storeId, { now }),
  ]);

  const movers = new Map<string, { name: string; units: number; priorUnits: number }>();
  for (const row of products.sellers) movers.set(row.listingId, { name: row.name, units: row.units, priorUnits: 0 });
  for (const row of priorProducts.sellers) {
    const seen = movers.get(row.listingId);
    if (seen) seen.priorUnits = row.units;
    else movers.set(row.listingId, { name: row.name, units: 0, priorUnits: row.units });
  }
  const change = (m: { units: number; priorUnits: number }) => m.units - m.priorUnits;
  const byChange = [...movers.values()].sort((a, b) => change(b) - change(a) || a.name.localeCompare(b.name));

  return {
    from: week.from,
    to: week.to,
    sales: {
      goodsCents: sales.goodsCents,
      orders: sales.orders,
      priorGoodsCents: priorSales.goodsCents,
      priorOrders: priorSales.orders,
      refundsCents: sales.refundsCents,
    },
    topSellers: products.sellers.slice(0, TOP_SELLERS).map((row) => ({ name: row.name, units: row.units })),
    moversUp: byChange.filter((m) => change(m) > 0).slice(0, MOVERS),
    moversDown: byChange.filter((m) => change(m) < 0).reverse().slice(0, MOVERS),
    runningOutSoon: stock.rows.flatMap((row) =>
      row.estimate.kind === "estimate" && row.estimate.daysLeft <= RUNNING_OUT_DAYS
        ? [{ name: row.name, qty: row.qty, daysLeft: row.estimate.daysLeft, outDay: row.estimate.outDay }]
        : []),
    shorts: products.shortOrSwapped.map((row) => ({ name: row.name, shortLines: row.shortLines, swappedLines: row.swappedLines })),
    issues,
    cancellations: operations.cancellations.map((row) => ({ reason: CANCEL_REASON_LABELS[row.reason] ?? row.reason, orders: row.orders })),
    swaps: { answered: operations.swapsAnswered, timedOut: operations.swapsTimedOut },
    repeat: { shoppers: customers.shoppers, repeatShoppers: customers.repeatShoppers, repeatRatePct: customers.repeatRatePct },
  };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const dayLabel = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
export const weekLabel = (f: Pick<WeeklyFigures, "from" | "to">) =>
  `${dayLabel.format(new Date(`${f.from}T00:00:00Z`))} to ${dayLabel.format(new Date(`${f.to}T00:00:00Z`))}`;

export interface ReportSection {
  title: string;
  lines: string[];
  empty: string;
}

/** The report as plain lines, shared by the email and the copilot page. */
export function reportSections(f: WeeklyFigures): ReportSection[] {
  const shortLine = (row: WeeklyFigures["shorts"][number]) => [
    row.shortLines > 0 ? `short on ${plural(row.shortLines, "order")}` : "",
    row.swappedLines > 0 ? `swapped on ${plural(row.swappedLines, "order")}` : "",
  ].filter(Boolean).join(", ");
  return [
    {
      title: "Sales",
      lines: [
        `Goods sales: ${money(f.sales.goodsCents)} from ${plural(f.sales.orders, "order")} (week before: ${money(f.sales.priorGoodsCents)} from ${plural(f.sales.priorOrders, "order")})`,
        `Refunded: ${money(f.sales.refundsCents)}`,
      ],
      empty: "",
    },
    { title: "Top sellers", lines: f.topSellers.map((s) => `${s.name}: ${s.units} sold`), empty: "No sales this week." },
    { title: "Selling more", lines: f.moversUp.map((m) => `${m.name}: ${m.units} sold (week before ${m.priorUnits})`), empty: "Nothing sold more than the week before." },
    { title: "Selling less", lines: f.moversDown.map((m) => `${m.name}: ${m.units} sold (week before ${m.priorUnits})`), empty: "Nothing sold less than the week before." },
    {
      title: "Running out soon",
      lines: f.runningOutSoon.map((r) => `${r.name}: ${r.qty ?? 0} left, est. out ${r.outDay}`),
      empty: "Nothing expected to run out in the next 3 days.",
    },
    { title: "Shorts by product", lines: f.shorts.map((s) => `${s.name}: ${shortLine(s)}`), empty: "No shorts this week." },
    {
      title: "Issues and refunds",
      lines: [
        ...f.issues.map((i) => `${i.reason}: ${plural(i.reports, "report")}, ${money(i.refundedCents)} refunded`),
        ...f.cancellations.map((c) => `${c.reason}: ${plural(c.orders, "cancelled order")}`),
      ],
      empty: "No issues reported and no orders cancelled.",
    },
    {
      title: "Customers",
      lines: [
        `Swap prompts: ${f.swaps.answered} answered, ${f.swaps.timedOut} timed out`,
        `Repeat customers: ${f.repeat.repeatRatePct}% (${f.repeat.repeatShoppers} of ${f.repeat.shoppers})`,
      ],
      empty: "",
    },
  ];
}

function renderReport(storeName: string, figures: WeeklyFigures, copilotUrl: string): string {
  const sections = reportSections(figures).map((section) => {
    const body = section.lines.length === 0
      ? `<p>${escapeHtml(section.empty)}</p>`
      : `<ul>${section.lines.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ul>`;
    return `<h2>${escapeHtml(section.title)}</h2>${body}`;
  });
  return [
    `<h1>${escapeHtml(storeName)}: your week, ${weekLabel(figures)}</h1>`,
    ...sections,
    `<p><a href="${escapeHtml(copilotUrl)}">Open the stock copilot</a></p>`,
  ].join("\n");
}

type ReportStore = { id: string; name: string; slug: string; timezone: string; digestHour: number };
const STORE_SELECT = { id: true, name: true, slug: true, timezone: true, digestHour: true } as const;

/**
 * Makes the week's row with its figures, claims it, emails each owner, and marks it sent. A failed send
 * releases the claim and throws; the figures stay, so the retry sends the same body under the same keys.
 */
async function sendStoreReport(store: ReportStore, timeZone: string, now: Date, env: Record<string, string | undefined>): Promise<boolean> {
  const owners = await storeScoped(store.id).storeMembership.findMany({
    where: { role: "owner" },
    select: { user: { select: { email: true } } },
  });
  if (owners.length === 0) return false;

  const week = reportWeek(timeZone, now);
  const key = { storeId_isoWeek: { storeId: store.id, isoWeek: week.isoWeek } };
  const exists = await storeScopedTransaction(store.id, (tx) => tx.copilotWeeklyReport.findUnique({ where: key, select: { id: true } }));
  if (!exists) {
    const figures = await weeklyFigures(store.id, timeZone, now);
    await storeScopedTransaction(store.id, (tx) => tx.copilotWeeklyReport.createMany({
      data: [{ storeId: store.id, isoWeek: week.isoWeek, weekStart: week.from, figures: figures as unknown as Prisma.InputJsonValue }],
      skipDuplicates: true,
    }));
  }

  const claimedAt = new Date();
  const claim = await storeScopedTransaction(store.id, (tx) => tx.copilotWeeklyReport.updateMany({
    where: {
      storeId: store.id,
      isoWeek: week.isoWeek,
      sentAt: null,
      OR: [{ claimedAt: null }, { claimedAt: { lt: new Date(claimedAt.getTime() - CLAIM_STALE_MS) } }],
    },
    data: { claimedAt },
  }));
  if (claim.count === 0) return false;

  try {
    const row = await storeScopedTransaction(store.id, (tx) => tx.copilotWeeklyReport.findUniqueOrThrow({ where: key, select: { figures: true } }));
    const figures = row.figures as unknown as WeeklyFigures;
    const base = resolveAuthBaseUrl(env).replace(/\/$/, "");
    const html = renderReport(store.name, figures, `${base}/store-admin/copilot?store=${encodeURIComponent(store.slug)}`);
    for (const owner of owners) {
      await sendEmail({
        to: owner.user.email,
        subject: `${store.name}: your week, ${weekLabel(figures)}`,
        html,
        idempotencyKey: `copilot-weekly:${store.id}:${week.isoWeek}:${owner.user.email}`,
      });
    }
    await storeScopedTransaction(store.id, (tx) => tx.copilotWeeklyReport.update({ where: key, data: { sentAt: new Date() } }));
    return true;
  } catch (err) {
    await storeScopedTransaction(store.id, (tx) => tx.copilotWeeklyReport.updateMany({
      where: { storeId: store.id, isoWeek: week.isoWeek, claimedAt, sentAt: null },
      data: { claimedAt: null },
    }));
    throw err;
  }
}

export interface WeeklyPageResult {
  /** Null once every store has been visited. */
  nextCursor: string | null;
  due: number;
  sent: number;
  failedStoreIds: string[];
}

/** Sends to the stores where it is Monday at their digest hour. A failed store is logged and returned. */
async function sendDueReports(stores: ReportStore[], now: Date, env: Record<string, string | undefined>) {
  let due = 0;
  let sent = 0;
  const failedStoreIds: string[] = [];
  for (const store of stores) {
    const timeZone = isValidTimezone(store.timezone) ? store.timezone : "UTC";
    const clock = localClock(timeZone, now);
    if (clock.hour !== store.digestHour || new Date(`${clock.date}T00:00:00Z`).getUTCDay() !== MONDAY) continue;
    due += 1;
    try {
      if (await sendStoreReport(store, timeZone, now, env)) sent += 1;
    } catch (err) {
      failedStoreIds.push(store.id);
      console.error(JSON.stringify({
        event: "copilot_weekly_report_store_failed",
        storeId: store.id,
        message: err instanceof Error ? err.message : String(err),
      }));
    }
  }
  return { due, sent, failedStoreIds };
}

/** One step of the hourly run: up to 100 stores. */
export async function runWeeklyPage(
  cursor: string | null,
  nowIso: string,
  env: Record<string, string | undefined> = process.env,
): Promise<WeeklyPageResult> {
  const stores = await platform.store.findMany({
    where: { ...(cursor ? { id: { gt: cursor } } : {}), status: { not: "suspended" } },
    orderBy: { id: "asc" },
    select: STORE_SELECT,
    take: STORES_PER_PAGE,
  });
  const result = await sendDueReports(stores, new Date(nowIso), env);
  return { nextCursor: stores.length < STORES_PER_PAGE ? null : (stores.at(-1)?.id ?? null), ...result };
}

/** The run's last step: sends again to the stores that failed, and throws while any still fails so Inngest retries it. */
export async function retryFailedReports(
  storeIds: string[],
  nowIso: string,
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  const stores = await platform.store.findMany({ where: { id: { in: storeIds } }, select: STORE_SELECT });
  const { failedStoreIds } = await sendDueReports(stores, new Date(nowIso), env);
  if (failedStoreIds.length > 0) throw new Error(`Copilot weekly report still failing for ${failedStoreIds.length} store${failedStoreIds.length === 1 ? "" : "s"}`);
}

export interface WeeklyReportView {
  isoWeek: string;
  figures: WeeklyFigures;
}

/** The last 8 reports sent, newest first, for the copilot page. */
export async function listWeeklyReports(storeId: string): Promise<WeeklyReportView[]> {
  const rows = await storeScopedTransaction(storeId, (tx) => tx.copilotWeeklyReport.findMany({
    where: { sentAt: { not: null } },
    orderBy: { weekStart: "desc" },
    take: REPORTS_SHOWN,
    select: { isoWeek: true, figures: true },
  }));
  return rows.map((row) => ({ isoWeek: row.isoWeek, figures: row.figures as unknown as WeeklyFigures }));
}

/** Hourly; each store's owners get one email on Monday at the store's digest hour. */
export const copilotWeeklyReport = inngest.createFunction(
  {
    id: "copilot/weekly-report",
    singleton: { mode: "skip" },
    checkpointing: { maxRuntime: "240s" },
    triggers: [{ cron: "TZ=UTC 0 * * * *" }],
  },
  async ({ step }) => {
    if (!process.env.RESEND_API_KEY) {
      console.warn(JSON.stringify({ event: "copilot_weekly_report_skipped_no_resend_key" }));
      return;
    }
    const nowIso = await step.run("clock", async () => new Date().toISOString());
    let cursor: string | null = null;
    let page = 0;
    const failedStoreIds: string[] = [];
    while (true) {
      const previous: string | null = cursor;
      const result: WeeklyPageResult = await step.run(`weekly-page-${page}`, () => runWeeklyPage(previous, nowIso));
      failedStoreIds.push(...result.failedStoreIds);
      if (result.nextCursor === null) break;
      cursor = result.nextCursor;
      page += 1;
    }
    if (failedStoreIds.length > 0) {
      await step.run("weekly-retry-failed", () => retryFailedReports(failedStoreIds, nowIso));
    }
  },
);
