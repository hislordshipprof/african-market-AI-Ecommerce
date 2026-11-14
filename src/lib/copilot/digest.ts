import { resolveAuthBaseUrl } from "../auth";
import { platform, platformAdminTransaction, storeScoped, storeScopedTransaction } from "../db";
import { sendEmail } from "../email/send";
import { inngest } from "../inngest/client";
import { escapeHtml } from "../notifications/messages";
import { isValidTimezone } from "../order/store-hours";
import { stockBadge, type StockBadge } from "../storefront/stock-badge";
import { describeAlerts, type AlertKind, type AlertView } from "./alerts";
import { listingLabel } from "./cards";

/** Owner decision 2026-11-10: 20:00 store time unless the owner changes it. */
export const DEFAULT_DIGEST_HOUR = 20;
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
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hourCycle: "h23",
  });
  const wall = (at: Date) => {
    const parts = format.formatToParts(at);
    const get = (type: Intl.DateTimeFormatPartTypes) => parseInt(parts.find((p) => p.type === type)?.value ?? "0", 10);
    return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour") % 24, minute: get("minute"), second: get("second") };
  };
  const offsetAt = (at: Date) => {
    const w = wall(at);
    return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - Math.floor(at.getTime() / 1000) * 1000;
  };
  const { year, month, day, hour } = wall(now);
  const midnight = Date.UTC(year, month - 1, day);
  // The offset at local midnight, not at `now`, so a DST change earlier today does not shift the day by an hour.
  const dayStart = new Date(midnight - offsetAt(new Date(midnight - offsetAt(now))));
  return {
    hour,
    date: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    dayStart,
  };
}

interface DigestData {
  alertsByKind: Map<AlertKind, AlertView[]>;
  confirmRequests: AlertView[];
  openConfirmRequests: number;
  bands: Record<StockBadge, number>;
  ordersToday: number;
  bestSellers: Array<{ name: string; units: number }>;
}

async function readDigest(storeId: string, since: Date): Promise<DigestData> {
  const scoped = storeScoped(storeId);
  const alertSelect = { id: true, kind: true, listingId: true, orderId: true, createdAt: true } as const;
  const [todayAlerts, confirms, openConfirmRequests, listings, ordersToday, sales] = await Promise.all([
    scoped.copilotAlert.findMany({ where: { createdAt: { gte: since } }, orderBy: { createdAt: "asc" }, select: alertSelect }),
    scoped.copilotAlert.findMany({
      where: { kind: "confirm_request", state: "open" },
      orderBy: { createdAt: "asc" },
      take: CONFIRM_REQUESTS_SHOWN,
      select: alertSelect,
    }),
    scoped.copilotAlert.count({ where: { kind: "confirm_request", state: "open" } }),
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
    openConfirmRequests,
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
  running_out_soon: "Running out soon",
  order_needs_low_stock: "Orders that need low stock",
  confirm_request: "Stock checks asked",
};

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
    data.openConfirmRequests > data.confirmRequests.length
      ? `<p>And ${data.openConfirmRequests - data.confirmRequests.length} more in the stock copilot.</p>`
      : "",
    `<h2>Listings</h2>`,
    `<p>In stock: ${data.bands["in-stock"]}. Limited: ${data.bands.limited}. Ask store: ${data.bands["ask-store"]}.</p>`,
    `<h2>Sales</h2>`,
    `<p>Orders today: ${data.ordersToday}</p>`,
    list(data.bestSellers.map((s) => `${s.name}: ${s.units} sold`), "No sales recorded today."),
    `<p><a href="${escapeHtml(copilotUrl)}">Open the stock copilot</a></p>`,
  ].join("\n");
}

/**
 * Claims the store's day with the rendered email, then emails each owner and marks it sent.
 * A failure or a crash leaves the claim unsent, so a retry resends the same body under the
 * same idempotency keys: owners already sent are replayed by Resend, not emailed twice.
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

  const day = { storeId_localDate: { storeId: store.id, localDate: clock.date } };
  const readClaim = () => storeScopedTransaction(store.id, (tx) =>
    tx.copilotDigest.findUnique({ where: day, select: { html: true, sentAt: true } }));
  let claim = await readClaim();
  if (!claim) {
    const data = await readDigest(store.id, clock.dayStart);
    const base = resolveAuthBaseUrl(env).replace(/\/$/, "");
    const html = renderDigest(store.name, clock.date, data, `${base}/store-admin/copilot?store=${encodeURIComponent(store.slug)}`);
    await storeScopedTransaction(store.id, (tx) =>
      tx.copilotDigest.createMany({ data: [{ storeId: store.id, localDate: clock.date, html }], skipDuplicates: true }));
    claim = await readClaim();
  }
  if (!claim || claim.sentAt) return false;

  for (const owner of owners) {
    await sendEmail({
      to: owner.user.email,
      subject: `${store.name}: daily stock digest`,
      html: claim.html,
      idempotencyKey: `copilot-digest:${store.id}:${clock.date}:${owner.user.email}`,
    });
  }
  await storeScopedTransaction(store.id, (tx) => tx.copilotDigest.update({ where: day, data: { sentAt: new Date() } }));
  return true;
}

export interface DigestPageResult {
  /** Null once every store has been visited. */
  nextCursor: string | null;
  due: number;
  sent: number;
  /** Retried in the run's last step, so one failing store never blocks the pages after it. */
  failedStoreIds: string[];
}

type DigestStore = { id: string; name: string; slug: string; timezone: string; digestHour: number };
const STORE_SELECT = { id: true, name: true, slug: true, timezone: true, digestHour: true } as const;

/** Sends to the stores whose local hour is their digest hour. A failed store is logged and returned. */
async function sendDueDigests(stores: DigestStore[], now: Date, env: Record<string, string | undefined>) {
  let due = 0;
  let sent = 0;
  const failedStoreIds: string[] = [];
  for (const store of stores) {
    const clock = localClock(isValidTimezone(store.timezone) ? store.timezone : "UTC", now);
    if (clock.hour !== store.digestHour) continue;
    due += 1;
    try {
      if (await sendStoreDigest(store, clock, env)) sent += 1;
    } catch (err) {
      failedStoreIds.push(store.id);
      console.error(JSON.stringify({
        event: "copilot_digest_store_failed",
        storeId: store.id,
        message: err instanceof Error ? err.message : String(err),
      }));
    }
  }
  return { due, sent, failedStoreIds };
}

/** One step of the hourly run: up to 100 stores. */
export async function runDigestPage(
  cursor: string | null,
  nowIso: string,
  env: Record<string, string | undefined> = process.env,
): Promise<DigestPageResult> {
  const stores = await platform.store.findMany({
    where: { ...(cursor ? { id: { gt: cursor } } : {}), status: { not: "suspended" } },
    orderBy: { id: "asc" },
    select: STORE_SELECT,
    take: STORES_PER_PAGE,
  });
  const result = await sendDueDigests(stores, new Date(nowIso), env);
  const last = stores.at(-1)?.id ?? null;
  return { nextCursor: stores.length < STORES_PER_PAGE ? null : last, ...result };
}

/** The run's last step: sends again to the stores that failed, and throws while any still fails so Inngest retries it. */
export async function retryFailedDigests(
  storeIds: string[],
  nowIso: string,
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  const stores = await platform.store.findMany({ where: { id: { in: storeIds } }, select: STORE_SELECT });
  const { failedStoreIds } = await sendDueDigests(stores, new Date(nowIso), env);
  if (failedStoreIds.length > 0) throw new Error(`Copilot digest still failing for ${failedStoreIds.length} stores`);
}

export async function loadDigestHour(storeId: string): Promise<number> {
  const store = await platform.store.findUnique({ where: { id: storeId }, select: { digestHour: true } });
  return store?.digestHour ?? DEFAULT_DIGEST_HOUR;
}

/** The owner's local send hour, 0 to 23, with an audit row. */
export async function setDigestHour(storeId: string, hour: number, actor: { id: string; email: string }): Promise<void> {
  await platformAdminTransaction(async (tx) => {
    const before = await tx.store.findUnique({ where: { id: storeId }, select: { digestHour: true } });
    if (!before || before.digestHour === hour) return;
    await tx.store.update({ where: { id: storeId }, data: { digestHour: hour } });
    await tx.auditLog.create({
      data: {
        storeId,
        actorId: actor.id,
        actorEmail: actor.email,
        action: "store.digest_hour",
        entityType: "store",
        entityId: storeId,
        before: { digestHour: before.digestHour },
        after: { digestHour: hour },
      },
    });
  });
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
    const failedStoreIds: string[] = [];
    while (true) {
      const previous: string | null = cursor;
      const result: DigestPageResult = await step.run(`digest-page-${page}`, () => runDigestPage(previous, nowIso));
      failedStoreIds.push(...result.failedStoreIds);
      if (result.nextCursor === null) break;
      cursor = result.nextCursor;
      page += 1;
    }
    if (failedStoreIds.length > 0) {
      await step.run("digest-retry-failed", () => retryFailedDigests(failedStoreIds, nowIso));
    }
  },
);
