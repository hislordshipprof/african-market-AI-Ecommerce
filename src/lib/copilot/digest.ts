import { resolveAuthBaseUrl } from "../auth";
import { Prisma, platform, platformAdminTransaction, storeScoped, storeScopedTransaction } from "../db";
import { salesRows, salesView } from "../analytics/queries";
import { sendEmail } from "../email/send";
import { inngest } from "../inngest/client";
import { escapeHtml, money } from "../format";
import { isValidTimezone } from "../order/store-hours";
import { stockBadge, type StockBadge } from "../storefront/stock-badge";
import { optedInOwners, sendOwnerNotice } from "../whatsapp/owner-notify";
import { COPILOT_TEMPLATES } from "../whatsapp/templates";
import { describeAlerts, isRunningLow, isSoldOut, type AlertKind, type AlertView } from "./alerts";
import { listingLabel } from "./cards";

/** Owner decision 2026-11-10: 20:00 store time unless the owner changes it. */
export const DEFAULT_DIGEST_HOUR = 20;
const STORES_PER_PAGE = 100;
const BEST_SELLERS = 5;
const CONFIRM_REQUESTS_SHOWN = 20;
const LOW_OR_OUT_SHOWN = 5;

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
  stockChanges: Array<{ type: string; events: number; units: number }>;
  soldOut: string[];
  runningLow: string[];
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
    scoped.listing.findMany({
      where: { active: true },
      orderBy: { id: "asc" },
      select: { confidence: true, stockMode: true, qty: true, status: true, customName: true, masterProduct: { select: { name: true } } },
    }),
    scoped.order.count({ where: { createdAt: { gte: since } } }),
    scoped.stockEvent.groupBy({
      by: ["listingId"],
      where: { type: "sale", createdAt: { gte: since } },
      _sum: { delta: true },
      orderBy: { _sum: { delta: "asc" } },
      take: BEST_SELLERS,
    }),
  ]);
  const changes = await scoped.stockEvent.groupBy({
    by: ["type"],
    where: { createdAt: { gte: since } },
    _count: { _all: true },
    _sum: { delta: true },
    orderBy: { type: "asc" },
  });

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
    stockChanges: changes.map((change) => ({
      type: change.type,
      events: change._count._all,
      units: Math.abs(change._sum.delta ?? 0),
    })),
    soldOut: listings.filter(isSoldOut).map(listingLabel),
    runningLow: listings.filter(isRunningLow).map(listingLabel),
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

/** The WhatsApp digest's facts (#144): template variables and text lines. Fixed at claim time. */
interface WhatsAppDigest {
  date: string;
  orders: number;
  goodsCents: number;
  stockChanges: string;
  lowOrOut: string;
}

const CHANGE_WORDS: Record<string, (c: { events: number; units: number }) => string> = {
  sale: (c) => `${c.units} sold online`,
  restock: (c) => `${c.units} restocked`,
  counter_sale: (c) => `${c.units} sold at the counter`,
  recount: (c) => `${c.events} ${c.events === 1 ? "recount" : "recounts"}`,
  adjust: (c) => `${c.events} status ${c.events === 1 ? "change" : "changes"}`,
};

function namesWithMore(names: string[]): string {
  const shown = names.slice(0, LOW_OR_OUT_SHOWN).join(", ");
  return names.length > LOW_OR_OUT_SHOWN ? `${shown} and ${names.length - LOW_OR_OUT_SHOWN} more` : shown;
}

function whatsappDigest(date: string, data: DigestData, goodsCents: number): WhatsAppDigest {
  const changes = data.stockChanges.map((c) => (CHANGE_WORDS[c.type] ?? ((x) => `${x.events} ${c.type.replace(/_/g, " ")}`))(c));
  const lowOrOut = [
    ...(data.soldOut.length > 0 ? [`out: ${namesWithMore(data.soldOut)}`] : []),
    ...(data.runningLow.length > 0 ? [`low: ${namesWithMore(data.runningLow)}`] : []),
  ];
  return {
    date,
    orders: data.ordersToday,
    goodsCents,
    stockChanges: changes.length > 0 ? changes.join(", ") : "none",
    lowOrOut: lowOrOut.length > 0 ? lowOrOut.join("; ") : "none",
  };
}

function readWhatsAppDigest(value: Prisma.JsonValue | null): WhatsAppDigest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  return typeof v.date === "string" && typeof v.orders === "number" && typeof v.goodsCents === "number"
    && typeof v.stockChanges === "string" && typeof v.lowOrOut === "string"
    ? { date: v.date, orders: v.orders, goodsCents: v.goodsCents, stockChanges: v.stockChanges, lowOrOut: v.lowOrOut }
    : null;
}

/**
 * The digest on WhatsApp to each owner who opted in (#144). Each owner is added to
 * `whatsapp_sent_to` before the send, so a retry or a second run never sends twice;
 * a send that fails or a run that dies after the claim leaves that owner without
 * today's WhatsApp digest (the email still goes).
 */
async function sendWhatsAppDigests(
  store: { id: string; name: string },
  localDate: string,
  digest: WhatsAppDigest,
  copilotUrl: string,
  now: Date,
): Promise<void> {
  const recipients = await optedInOwners(store.id, "digest", now);
  const text = [
    `${store.name}: your day, ${digest.date}`,
    `Orders: ${digest.orders}`,
    `Goods sales: ${money(digest.goodsCents)}`,
    `Stock changes: ${digest.stockChanges}`,
    `Low or out of stock: ${digest.lowOrOut}`,
    "",
    `Open the stock copilot: ${copilotUrl}`,
  ].join("\n");
  for (const recipient of recipients) {
    const claimed = await storeScopedTransaction(store.id, (tx) => tx.$executeRaw`
      UPDATE copilot_digests
      SET whatsapp_sent_to = array_append(whatsapp_sent_to, ${recipient.userId})
      WHERE store_id = ${store.id} AND local_date = ${localDate} AND NOT (${recipient.userId} = ANY (whatsapp_sent_to))
    `);
    if (claimed !== 1) continue;
    await sendOwnerNotice(store.id, recipient, {
      text,
      template: COPILOT_TEMPLATES.digest,
      values: [store.name, digest.date, String(digest.orders), money(digest.goodsCents), digest.stockChanges, digest.lowOrOut],
    });
  }
}

/**
 * Claims the store's day with the rendered email, then emails each owner and marks it sent.
 * A failure or a crash leaves the claim unsent, so a retry resends the same body under the
 * same idempotency keys: owners already sent are replayed by Resend, not emailed twice.
 */
async function sendStoreDigest(
  store: { id: string; name: string; slug: string; timezone: string },
  clock: LocalClock,
  env: Record<string, string | undefined>,
  now: Date,
): Promise<boolean> {
  const owners = await storeScoped(store.id).storeMembership.findMany({
    where: { role: "owner" },
    select: { user: { select: { id: true, email: true } } },
  });
  if (owners.length === 0) return false;

  const day = { storeId_localDate: { storeId: store.id, localDate: clock.date } };
  const readClaim = () => storeScopedTransaction(store.id, (tx) =>
    tx.copilotDigest.findUnique({ where: day, select: { html: true, sentAt: true, whatsappSummary: true } }));
  const base = resolveAuthBaseUrl(env).replace(/\/$/, "");
  const copilotUrl = `${base}/store-admin/copilot?store=${encodeURIComponent(store.slug)}`;
  let claim = await readClaim();
  if (!claim) {
    const timeZone = isValidTimezone(store.timezone) ? store.timezone : "UTC";
    const range = { preset: "custom" as const, from: clock.date, to: clock.date };
    // Goods sales as on the analytics page: captured orders placed today, less fees and tip.
    const [data, sales] = await Promise.all([readDigest(store.id, clock.dayStart), salesRows(store.id, range, timeZone)]);
    const html = renderDigest(store.name, clock.date, data, copilotUrl);
    const whatsappSummary = { ...whatsappDigest(clock.date, data, salesView(sales, range).totals.goodsCents) };
    await storeScopedTransaction(store.id, (tx) =>
      tx.copilotDigest.createMany({
        data: [{ storeId: store.id, localDate: clock.date, html, whatsappSummary }],
        skipDuplicates: true,
      }));
    claim = await readClaim();
  }
  if (!claim || claim.sentAt) return false;

  const summary = readWhatsAppDigest(claim.whatsappSummary);
  if (summary) await sendWhatsAppDigests(store, clock.date, summary, copilotUrl, now);

  for (const owner of owners) {
    await sendEmail({
      to: owner.user.email,
      subject: `${store.name}: daily stock digest`,
      html: claim.html,
      idempotencyKey: `copilot-digest:${store.id}:${clock.date}:${owner.user.id}`,
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
      if (await sendStoreDigest(store, clock, env, now)) sent += 1;
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
