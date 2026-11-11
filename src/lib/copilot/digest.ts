import { resolveAuthBaseUrl } from "../auth";
import { platform, storeScoped, storeScopedTransaction } from "../db";
import { sendEmail } from "../email/send";
import { inngest } from "../inngest/client";
import { isValidTimezone } from "../order/store-hours";
import { stockBadge, type StockBadge } from "../storefront/stock-badge";
import { describeAlerts, type AlertKind, type AlertView } from "./alerts";
import { listingLabel } from "./cards";

const STORES_PER_PAGE = 100;
const BEST_SELLERS = 5;
const CONFIRM_REQUESTS_SHOWN = 20;

interface LocalClock {
  hour: number;
  /** YYYY-MM-DD in the store's zone. */
  date: string;
  dayStart: Date;
}

/** The store's wall clock at `now`, and the instant its local day began. */
export function localClock(timeZone: string, now: Date): LocalClock {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes) => parseInt(parts.find((p) => p.type === type)?.value ?? "0", 10);
  const [year, month, day, hour] = [get("year"), get("month"), get("day"), get("hour") % 24];
  const offset = Date.UTC(year, month - 1, day, hour, get("minute"), get("second")) - Math.floor(now.getTime() / 1000) * 1000;
  return {
    hour,
    date: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    dayStart: new Date(Date.UTC(year, month - 1, day) - offset),
  };
}

interface DigestData {
  alertsByKind: Map<AlertKind, AlertView[]>;
  confirmRequests: AlertView[];
  bands: Record<StockBadge, number>;
  ordersToday: number;
  bestSellers: Array<{ name: string; units: number }>;
}

async function readDigest(storeId: string, since: Date): Promise<DigestData> {
  const scoped = storeScoped(storeId);
  const alertSelect = { id: true, kind: true, listingId: true, orderId: true, createdAt: true } as const;
  const [todayAlerts, confirms, listings, ordersToday, sales] = await Promise.all([
    scoped.copilotAlert.findMany({ where: { createdAt: { gte: since } }, orderBy: { createdAt: "asc" }, select: alertSelect }),
    scoped.copilotAlert.findMany({
      where: { kind: "confirm_request", state: "open" },
      orderBy: { createdAt: "asc" },
      take: CONFIRM_REQUESTS_SHOWN,
      select: alertSelect,
    }),
    scoped.listing.findMany({ where: { active: true }, select: { confidence: true, stockMode: true, qty: true, status: true } }),
    scoped.order.count({ where: { createdAt: { gte: since } } }),
    scoped.stockEvent.groupBy({
      by: ["listingId"],
      where: { type: "sale", createdAt: { gte: since } },
      _sum: { delta: true },
      orderBy: { _sum: { delta: "asc" } },
      take: BEST_SELLERS,
    }),
  ]);

  const alertsByKind = new Map<AlertKind, AlertView[]>();
  for (const view of await describeAlerts(storeId, todayAlerts)) {
    alertsByKind.set(view.kind, [...(alertsByKind.get(view.kind) ?? []), view]);
  }
  const bands: Record<StockBadge, number> = { "in-stock": 0, limited: 0, "ask-store": 0 };
  for (const listing of listings) bands[stockBadge(listing)] += 1;

  const named = await scoped.listing.findMany({
    where: { id: { in: sales.map((s) => s.listingId) } },
    select: { id: true, customName: true, masterProduct: { select: { name: true } } },
  });
  const nameById = new Map(named.map((l) => [l.id, listingLabel(l)]));
  return {
    alertsByKind,
    confirmRequests: await describeAlerts(storeId, confirms),
    bands,
    ordersToday,
    bestSellers: sales
      .map((s) => ({ name: nameById.get(s.listingId) ?? "Unnamed", units: -(s._sum.delta ?? 0) }))
      .filter((s) => s.units > 0),
  };
}

const KIND_HEADINGS: Record<AlertKind, string> = {
  sold_out: "Sold out",
  running_low: "Running low",
  order_needs_low_stock: "Orders that need low stock",
  confirm_request: "Stock checks asked",
};

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function list(items: string[], empty: string): string {
  if (items.length === 0) return `<p>${empty}</p>`;
  return `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}

function renderDigest(storeName: string, date: string, data: DigestData, copilotUrl: string): string {
  const alerts = [...data.alertsByKind].map(([kind, views]) =>
    `<h3>${KIND_HEADINGS[kind]} (${views.length})</h3>${list(views.map((v) => v.text), "")}`).join("");
  return [
    `<h1>${escapeHtml(storeName)}: your day, ${date}</h1>`,
    `<h2>Today's alerts</h2>`,
    alerts || "<p>No alerts today.</p>",
    `<h2>Stock checks waiting for you</h2>`,
    list(data.confirmRequests.map((v) => v.text), "None."),
    `<h2>Listings</h2>`,
    `<p>In stock: ${data.bands["in-stock"]}. Limited: ${data.bands.limited}. Ask store: ${data.bands["ask-store"]}.</p>`,
    `<h2>Sales</h2>`,
    `<p>Orders today: ${data.ordersToday}</p>`,
    list(data.bestSellers.map((s) => `${s.name}: ${s.units} sold`), "No sales recorded today."),
    `<p><a href="${escapeHtml(copilotUrl)}">Open the stock copilot</a></p>`,
  ].join("\n");
}

/**
 * Claims the store's day, then emails each owner. A failure releases the claim so a
 * retry sends; a claim already held means the day went out. Returns whether it sent.
 */
async function sendStoreDigest(
  store: { id: string; name: string; slug: string },
  clock: LocalClock,
  env: Record<string, string | undefined>,
): Promise<boolean> {
  const owners = await storeScoped(store.id).storeMembership.findMany({
    where: { role: "owner" },
    select: { user: { select: { email: true } } },
  });
  if (owners.length === 0) return false;

  const data = await readDigest(store.id, clock.dayStart);
  const claimed = await storeScopedTransaction(store.id, (tx) =>
    tx.copilotDigest.createMany({ data: [{ storeId: store.id, localDate: clock.date }], skipDuplicates: true }));
  if (claimed.count === 0) return false;

  const base = resolveAuthBaseUrl(env).replace(/\/$/, "");
  const html = renderDigest(store.name, clock.date, data, `${base}/store-admin/copilot?store=${encodeURIComponent(store.slug)}`);
  try {
    for (const owner of owners) {
      await sendEmail({
        to: owner.user.email,
        subject: `${store.name}: daily stock digest`,
        html,
        idempotencyKey: `copilot-digest:${store.id}:${clock.date}:${owner.user.email}`,
      });
    }
  } catch (err) {
    await storeScopedTransaction(store.id, (tx) =>
      tx.copilotDigest.deleteMany({ where: { storeId: store.id, localDate: clock.date } }));
    throw err;
  }
  return true;
}

export interface DigestPageResult {
  /** Null once every store has been visited. */
  nextCursor: string | null;
  due: number;
  sent: number;
  failed: number;
}

/**
 * One step of the hourly run: up to 100 stores, sending to those whose local hour is
 * their digest hour. A failed store is logged; a page where every due store failed
 * throws so Inngest retries it.
 */
export async function runDigestPage(
  cursor: string | null,
  nowIso: string,
  env: Record<string, string | undefined> = process.env,
): Promise<DigestPageResult> {
  const now = new Date(nowIso);
  const stores = await platform.store.findMany({
    where: { ...(cursor ? { id: { gt: cursor } } : {}), status: { not: "suspended" } },
    orderBy: { id: "asc" },
    select: { id: true, name: true, slug: true, timezone: true, digestHour: true },
    take: STORES_PER_PAGE,
  });
  let due = 0;
  let sent = 0;
  let failed = 0;
  for (const store of stores) {
    const clock = localClock(isValidTimezone(store.timezone) ? store.timezone : "UTC", now);
    if (clock.hour !== store.digestHour) continue;
    due += 1;
    try {
      if (await sendStoreDigest(store, clock, env)) sent += 1;
    } catch (err) {
      failed += 1;
      console.error(JSON.stringify({
        event: "copilot_digest_store_failed",
        storeId: store.id,
        message: err instanceof Error ? err.message : String(err),
      }));
    }
  }
  if (due > 0 && failed === due) throw new Error(`Copilot digest failed for all ${due} due stores in this page`);
  const last = stores.at(-1)?.id ?? null;
  return { nextCursor: stores.length < STORES_PER_PAGE ? null : last, due, sent, failed };
}

/** Hourly; each store's owners get one email at the store's local digest hour. */
export const copilotDailyDigest = inngest.createFunction(
  {
    id: "copilot/daily-digest",
    singleton: { mode: "skip" },
    checkpointing: { maxRuntime: "240s" },
    triggers: [{ cron: "TZ=UTC 0 * * * *" }],
  },
  async ({ step }) => {
    if (!process.env.RESEND_API_KEY) {
      console.warn(JSON.stringify({ event: "copilot_digest_skipped_no_resend_key" }));
      return;
    }
    // One clock for every page, so a slow or retried page still matches the same hour.
    const nowIso = await step.run("clock", async () => new Date().toISOString());
    let cursor: string | null = null;
    let page = 0;
    while (true) {
      const previous: string | null = cursor;
      const result: DigestPageResult = await step.run(`digest-page-${page}`, () => runDigestPage(previous, nowIso));
      if (result.nextCursor === null) break;
      cursor = result.nextCursor;
      page += 1;
    }
  },
);
