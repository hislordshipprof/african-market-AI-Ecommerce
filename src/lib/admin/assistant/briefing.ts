import { platformAdmin, platformAdminTransaction } from "../../db";
import { requestsByArea } from "../../directory/store-requests";
import { assistantSpendState } from "../../assistant/spend";
import { listStoreApplications, PENDING_APPLICATIONS_LISTED } from "../../store-application/service";
import { platformWaitingWhere } from "../../support/thread";
import { listChatMonth } from "../ai-eval-spend";
import { findCourierIncidents } from "../courier-incidents-query";
import { readOpenDisputes } from "../disputes";
import { plural, type AdminBriefing, type BriefingItem, type BriefingKey } from "./briefing-view";

export { briefingSummary, type AdminBriefing, type BriefingItem } from "./briefing-view";

/** A store still in setup this long after it was created is stuck in onboarding (owner decision, #834). */
export const ONBOARDING_STUCK_DAYS = 3;
/** AI spend at this share of the daily cap is near it. No near-cap line existed before #834. */
export const SPEND_NEAR_CAP = 0.8;
const INCIDENTS_READ = 200;
const NAMES_SHOWN = 5;


/**
 * What needs an admin today, read straight from the records the admin screens list (no session check, so the daily
 * email can run it; the page checks the admin first). Only items with something waiting are returned.
 */
export async function adminBriefing(now: Date): Promise<AdminBriefing> {
  const stuckBefore = new Date(now.getTime() - ONBOARDING_STUCK_DAYS * 86_400_000);
  const parts: Array<[BriefingKey, () => Promise<Omit<BriefingItem, "key"> | null>]> = [
    ["applications", async () => {
      const { pending } = await listStoreApplications();
      return pending.length === 0 ? null : {
        count: pending.length,
        incomplete: pending.length >= PENDING_APPLICATIONS_LISTED,
        label: plural(pending.length, "new store application", "new store applications"),
        names: pending.slice(0, NAMES_SHOWN).map((row) => row.businessName),
        href: "/admin/applications",
        ask: "Check the new store applications.",
      };
    }],
    ["store_requests", async () => {
      const waiting = (await requestsByArea()).flatMap((area) => area.zips).reduce((sum, zip) => sum + zip.waiting, 0);
      return waiting === 0 ? null : {
        count: waiting,
        incomplete: false,
        label: plural(waiting, "shopper request for a store nearby", "shopper requests for a store nearby"),
        names: [],
        href: "/admin/store-requests",
        ask: "Which areas are asking for a store?",
      };
    }],
    ["refund_failed", async () => {
      const count = await platformAdminTransaction((tx) => tx.order.count({ where: { status: "REFUND_FAILED" } }));
      return count === 0 ? null : {
        count,
        incomplete: false,
        label: plural(count, "order whose refund failed", "orders whose refund failed"),
        names: [],
        href: "/admin/orders",
        ask: "Which refunds failed and what is still owed?",
      };
    }],
    ["courier_incidents", async () => {
      const { rows, nextCursor } = await platformAdminTransaction((tx) => findCourierIncidents(tx, {}, INCIDENTS_READ));
      const open = rows.filter((row) => row.state === "open").length;
      return open === 0 ? null : {
        count: open,
        incomplete: nextCursor !== null,
        label: plural(open, "open courier incident", "open courier incidents"),
        names: [],
        href: "/admin/couriers/incidents",
        ask: "Show the open courier incidents.",
      };
    }],
    ["disputes", async () => {
      const { rows, more } = await readOpenDisputes();
      return rows.length === 0 ? null : {
        count: rows.length,
        incomplete: more,
        label: plural(rows.length, "open card dispute", "open card disputes"),
        names: [],
        href: "/admin/disputes",
        ask: "Show the open card disputes and when evidence is due.",
      };
    }],
    ["support", async () => {
      const count = await platformAdminTransaction((tx) => tx.supportThread.count({ where: platformWaitingWhere(tx.supportThread.fields.lastReplyAt) }));
      return count === 0 ? null : {
        count,
        incomplete: false,
        label: plural(count, "customer message waiting on the platform", "customer messages waiting on the platform"),
        names: [],
        href: "/admin/support",
        ask: "Which customer messages are waiting on us?",
      };
    }],
    ["onboarding_stuck", async () => {
      const stores = await platformAdmin.store.findMany({
        where: { status: "setup", createdAt: { lt: stuckBefore } },
        orderBy: { createdAt: "asc" },
        select: { name: true },
      });
      return stores.length === 0 ? null : {
        count: stores.length,
        incomplete: false,
        label: plural(stores.length, `store in setup for more than ${ONBOARDING_STUCK_DAYS} days`, `stores in setup for more than ${ONBOARDING_STUCK_DAYS} days`),
        names: stores.slice(0, NAMES_SHOWN).map((store) => store.name),
        href: "/admin/stores",
        ask: `Which stores have been in setup for more than ${ONBOARDING_STUCK_DAYS} days, and what is still open for each?`,
      };
    }],
    ["chat_cap", async () => {
      const near = (await listChatMonth(now)).stores.filter((store) => store.nearCap);
      return near.length === 0 ? null : {
        count: near.length,
        incomplete: false,
        label: plural(near.length, "store near its chat cap", "stores near their chat cap"),
        names: near.slice(0, NAMES_SHOWN).map((store) => store.storeName),
        href: "/admin/ai/eval-spend",
        ask: "Which stores are near their chat cap this month?",
      };
    }],
    ["ai_spend", async () => {
      const spend = await assistantSpendState();
      const near = spend.resting || (spend.capMicros > BigInt(0) && Number(spend.spentMicros) >= Number(spend.capMicros) * SPEND_NEAR_CAP);
      return !near ? null : {
        count: 1,
        incomplete: false,
        label: spend.resting ? "AI spend reached today's cap" : "AI spend is near today's cap",
        names: [],
        href: "/admin/ai/eval-spend",
        ask: "How much AI spend is used against today's cap?",
      };
    }],
  ];
  const settled = await Promise.allSettled(parts.map(([, read]) => read()));
  const items: BriefingItem[] = [];
  const unread: BriefingKey[] = [];
  settled.forEach((result, index) => {
    const key = parts[index]![0];
    if (result.status === "rejected") {
      console.error("[admin briefing] read failed", { key, errorType: result.reason instanceof Error ? result.reason.name : "Error" });
      unread.push(key);
    } else if (result.value) {
      items.push({ key, ...result.value });
    }
  });
  return { items, unread };
}
