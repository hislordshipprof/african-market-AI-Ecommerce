import { tool } from "ai";
import { z } from "zod";
import { platformAdminTransaction } from "../../db";
import { readGoLiveChecklist, goLiveItemLabel } from "../../go-live/checklist";
import { listStoreApplications } from "../../store-application/service";
import { listEscalatedThreads } from "../../support/platform-actions";
import { getStoreSubscription, listStores } from "../actions";
import { getReviewStats, listAttributeProposals } from "../catalog-actions";
import { listConversationSample } from "../ai-oversight";
import { loadAiEvalSpend } from "../ai-eval-spend";
import { listDuplicatePairs } from "../catalog-duplicates";
import { listCourierIncidents } from "../courier-incidents";
import { INCIDENT_KINDS } from "../courier-incidents-query";
import { listOpenDisputes } from "../disputes";
import { listMetros } from "../metros";
import { ORDER_STATUSES } from "../order-search";
import { searchOrders } from "../order-search-query";
import { listOrdersToCheck } from "../orders-to-check";
import { platformTotals } from "../platform-totals";
import { listProductProposals } from "../product-proposals";
import { listRefundFailedOrders } from "../refund-resolution";
import { listStoreRequestAreas } from "../store-requests";
import { ROWS_MAX, type AssistantLink } from "./types";
import { draftTools } from "./draft-tools";
import type { PendingAdminDraft } from "./drafts";

const dollars = (cents: number | bigint) => Number(cents) / 100;
const day = (value: Date | string) => new Date(value).toISOString().slice(0, 10);

/** What one turn's tools read and drafted: the links under the reply, every result the reply may quote from, the draft cards. */
export interface ReadBook {
  links: AssistantLink[];
  toolResults: string[];
  drafts: PendingAdminDraft[];
}

export function createReadBook(): ReadBook {
  return { links: [], toolResults: [], drafts: [] };
}

export interface ToolContext {
  actor: { id: string; email: string };
  conversationId: string;
  book: ReadBook;
  now: Date;
}

export function link(book: ReadBook, label: string, href: string): string {
  if (!book.links.some((item) => item.href === href)) book.links.push({ label, href });
  return href;
}

/** Writes the audit row before the tool runs, so a call is on record even if the turn then fails. */
export async function audited<T>(ctx: ToolContext, name: string, params: Record<string, unknown>, read: () => Promise<T>): Promise<T> {
  await platformAdminTransaction((tx) => tx.auditLog.create({
    data: {
      actorId: ctx.actor.id,
      actorEmail: ctx.actor.email,
      action: "admin_assistant.tool",
      entityType: "admin_assistant_conversation",
      entityId: ctx.conversationId,
      after: { tool: name, params: JSON.parse(JSON.stringify(params)) },
    },
  }));
  const result = await read();
  ctx.book.toolResults.push(JSON.stringify(result));
  return result;
}

const STORE_STATUSES = ["setup", "active", "suspended"] as const;

/**
 * Every tool reads through the same function the admin screen uses. The read tools write nothing but the audit row;
 * the draft tools add a card the admin confirms, and nothing changes before that.
 */
export function adminAssistantTools(ctx: ToolContext) {
  const { book } = ctx;
  return {
    ...draftTools(ctx),
    find_stores: tool({
      description: "Find stores by name or slug and/or status (setup is still onboarding). Each store has its plan, metro, open go-live items and each courier's registration error.",
      inputSchema: z.object({
        query: z.string().max(100).optional(),
        status: z.enum(STORE_STATUSES).optional(),
      }),
      execute: (input) => audited(ctx, "find_stores", input, async () => {
        const [stores, metros] = await Promise.all([listStores(), listMetros()]);
        const metroName = new Map(metros.map((metro) => [metro.id, metro.name]));
        const query = input.query?.trim().toLowerCase();
        const matched = stores.filter((store) => (
          (!input.status || store.status === input.status)
          && (!query || store.name.toLowerCase().includes(query) || store.slug.includes(query))
        ));
        const rows = await Promise.all(matched.slice(0, ROWS_MAX).map(async (store) => {
          const checklist = store.status === "setup" ? await readGoLiveChecklist(store.id, ctx.now) : null;
          link(book, store.name, `/admin/stores/${store.id}`);
          return {
            name: store.name,
            slug: store.slug,
            status: store.status,
            plan: store.plan,
            metro: store.metroId ? metroName.get(store.metroId) ?? null : null,
            goLiveOpen: checklist
              ? checklist.items.filter((item) => !item.done).map((item) => `${goLiveItemLabel(item.key, checklist.floor)}: ${item.detail}`)
              : null,
            courierRegistrationErrors: { doordash: store.doordashRegistrationError, uber: store.uberRegistrationError },
            created: day(store.createdAt),
          };
        }));
        return { total: matched.length, shown: rows.length, stores: rows };
      }),
    }),

    store_detail: tool({
      description: "One store in depth, by its slug: status, plan and billing, metro, payouts, couriers, the go-live checklist.",
      inputSchema: z.object({ slug: z.string().min(1).max(100) }),
      execute: (input) => audited(ctx, "store_detail", input, async () => {
        const store = (await listStores()).find((row) => row.slug === input.slug.trim().toLowerCase());
        if (!store) return { found: false };
        const [subscription, checklist, metros] = await Promise.all([
          getStoreSubscription(store.id),
          readGoLiveChecklist(store.id, ctx.now),
          listMetros(),
        ]);
        link(book, store.name, `/admin/stores/${store.id}`);
        return {
          found: true,
          name: store.name,
          slug: store.slug,
          status: store.status,
          plan: store.plan,
          billingStatus: subscription?.status ?? null,
          pilot: subscription?.pilot ?? false,
          metro: metros.find((metro) => metro.id === store.metroId)?.name ?? null,
          payouts: store.stripeOnboardingStatus,
          doordashRegistered: Boolean(store.doordashStoreId),
          uberRegistered: Boolean(store.uberLocationId),
          courierRegistrationErrors: { doordash: store.doordashRegistrationError, uber: store.uberRegistrationError },
          goLive: checklist?.items.map((item) => ({ item: goLiveItemLabel(item.key, checklist.floor), done: item.done, detail: item.detail })) ?? [],
          created: day(store.createdAt),
        };
      }),
    }),

    search_orders: tool({
      description: "Search orders across stores by order number, customer email, store slug and/or status. Newest first.",
      inputSchema: z.object({
        number: z.number().int().positive().optional(),
        email: z.string().max(320).optional(),
        storeSlug: z.string().max(100).optional(),
        status: z.enum(ORDER_STATUSES).optional(),
      }),
      execute: (input) => audited(ctx, "search_orders", input, async () => {
        let storeId: string | null = null;
        if (input.storeSlug) {
          const store = (await listStores()).find((row) => row.slug === input.storeSlug!.trim().toLowerCase());
          if (!store) return { storeFound: false, orders: [] };
          storeId = store.id;
        }
        const { rows, nextCursor } = await searchOrders({
          storeId,
          number: input.number ?? null,
          email: input.email?.trim().toLowerCase() || null,
          phone: null,
          status: input.status ?? null,
          fulfillment: null,
          from: null,
          to: null,
          cursor: null,
        }, { pageSize: ROWS_MAX });
        return {
          more: nextCursor !== null,
          orders: rows.map((row) => {
            link(book, `Order ${row.number}, ${row.storeName}`, `/admin/orders/search/${row.id}`);
            return {
              number: row.number,
              store: row.storeName,
              status: row.status,
              fulfillment: row.fulfillment,
              authorizedDollars: dollars(row.totalAuthorizedCents),
              placed: day(row.createdAt),
            };
          }),
        };
      }),
    }),

    orders_to_check: tool({
      description: "Orders stuck in a state for too long, and order alerts, as on Orders to check.",
      inputSchema: z.object({}),
      execute: () => audited(ctx, "orders_to_check", {}, async () => {
        const result = await listOrdersToCheck();
        link(book, "Orders to check", "/admin/orders/check");
        return {
          stuck: result.stuck.length,
          stuckShown: result.stuck.slice(0, ROWS_MAX).map((row) => {
            link(book, `Order ${row.orderNumber}, ${row.storeName}`, `/admin/orders/search/${row.orderId}`);
            return { number: row.orderNumber, store: row.storeName, status: row.status, reason: row.reason, since: day(row.since) };
          }),
          alerts: result.alerts.length,
          capped: result.cappedGroups.length > 0 || result.alertsCapped,
        };
      }),
    }),

    refund_failed_orders: tool({
      description: "Orders whose refund failed and still owe the customer money, as on Refunds.",
      inputSchema: z.object({}),
      execute: () => audited(ctx, "refund_failed_orders", {}, async () => {
        const rows = await listRefundFailedOrders();
        link(book, "Refunds", "/admin/orders");
        return {
          total: rows.length,
          orders: rows.slice(0, ROWS_MAX).map((row) => {
            link(book, `Order ${row.orderNumber}, ${row.storeName}`, `/admin/orders/search/${row.orderId}`);
            return {
              number: row.orderNumber,
              store: row.storeName,
              owedDollars: dollars(row.owedCents),
              failed: row.failedAtLabel,
              bankRefundPending: row.bankRefundPending,
            };
          }),
        };
      }),
    }),

    courier_incidents: tool({
      description: "Courier incidents (failover, both couriers failed, cancelled, returned, late, no proof), newest first, as on Courier incidents.",
      inputSchema: z.object({ kind: z.enum(INCIDENT_KINDS).optional() }),
      execute: (input) => audited(ctx, "courier_incidents", input, async () => {
        const result = await listCourierIncidents(input.kind ? { kind: input.kind } : {});
        link(book, "Courier incidents", "/admin/couriers/incidents");
        return {
          more: result.nextCursor !== null,
          incidents: result.rows.slice(0, ROWS_MAX).map((row) => {
            link(book, `Order ${row.orderNumber}, ${row.storeName}`, `/admin/couriers/incidents/${row.orderId}`);
            return {
              orderId: row.orderId,
              number: row.orderNumber,
              store: row.storeName,
              kinds: row.kinds,
              couriers: row.providers,
              state: row.state,
              opened: day(row.openedAt),
            };
          }),
        };
      }),
    }),

    applications_waiting: tool({
      description: "Store applications waiting for a decision, and shopper requests for a store in their area, by state and ZIP.",
      inputSchema: z.object({}),
      execute: () => audited(ctx, "applications_waiting", {}, async () => {
        const [{ pending }, areas] = await Promise.all([listStoreApplications(), listStoreRequestAreas()]);
        link(book, "Applications", "/admin/applications");
        link(book, "Store requests", "/admin/store-requests");
        const zips = areas.flatMap((area) => area.zips.map((zip) => ({ state: area.state, ...zip })));
        return {
          applicationsWaiting: pending.length,
          applications: pending.slice(0, ROWS_MAX).map((row) => ({
            applicationId: row.id,
            business: row.businessName,
            city: row.city,
            state: row.state,
            applied: day(row.createdAt),
          })),
          requestAreas: zips
            .filter((zip) => zip.waiting > 0)
            .sort((a, b) => b.waiting - a.waiting)
            .slice(0, ROWS_MAX)
            .map((zip) => ({ state: zip.state, zip: zip.zip, place: zip.place, waiting: zip.waiting })),
        };
      }),
    }),

    support_and_disputes: tool({
      description: "Customer messages escalated to the platform that are still open, and open card disputes with their evidence due dates.",
      inputSchema: z.object({}),
      execute: () => audited(ctx, "support_and_disputes", {}, async () => {
        const [{ threads, hidden }, disputes] = await Promise.all([listEscalatedThreads(), listOpenDisputes()]);
        link(book, "Messages", "/admin/support");
        link(book, "Disputes", "/admin/disputes");
        return {
          messagesOpen: threads.length + hidden,
          messages: threads.slice(0, ROWS_MAX).map((thread) => {
            link(book, `Message on order ${thread.orderNumber}, ${thread.storeName}`, `/admin/support?selected=${thread.id}`);
            return {
              threadId: thread.id,
              order: thread.orderNumber,
              store: thread.storeName,
              topic: thread.topic,
              lastCustomerMessage: thread.messages.findLast((message) => message.sender === "customer")?.body.slice(0, 500) ?? null,
              reason: thread.escalationReason,
              waitingOnPlatform: thread.waiting,
              ageMinutes: thread.ageMinutes,
            };
          }),
          disputesOpen: disputes.rows.length,
          more: disputes.more,
          disputes: disputes.rows.slice(0, ROWS_MAX).map((row) => {
            if (row.orderId) link(book, `Dispute on order ${row.orderNumber}, ${row.storeName}`, `/admin/orders/search/${row.orderId}`);
            return {
              order: row.orderNumber,
              store: row.storeName,
              amountDollars: dollars(row.amountCents),
              reason: row.reason,
              status: row.status,
              evidenceDue: row.evidenceDueBy ? day(row.evidenceDueBy) : null,
            };
          }),
        };
      }),
    }),

    ai_spend_and_flags: tool({
      description: "AI spend against the daily cap (last 30 days), stores near their chat cap this month, and today's flagged AI chats.",
      inputSchema: z.object({}),
      execute: () => audited(ctx, "ai_spend_and_flags", {}, async () => {
        const [spend, sample] = await Promise.all([loadAiEvalSpend(ctx.now), listConversationSample({})]);
        link(book, "AI eval and spend", "/admin/ai/eval-spend");
        link(book, "AI conversations", "/admin/ai/conversations");
        const flagged = [...sample.shopper, ...sample.copilot].filter((row) => row.reasons.length > 0).slice(0, ROWS_MAX);
        for (const row of flagged) link(book, `Flagged ${row.kind} chat, ${row.storeName}`, `/admin/ai/conversations/${row.kind}/${row.id}`);
        return {
          spentTodayDollars: dollars(spend.spend.spentMicros / BigInt(10_000)),
          capDollars: dollars(spend.spend.capMicros / BigInt(10_000)),
          resting: spend.spend.resting,
          last30Days: spend.spend.days.map((row) => ({ day: row.day, dollars: dollars(row.costMicros / BigInt(10_000)), capAlerted: row.capAlerted })),
          storesNearChatCap: spend.chats.stores.filter((store) => store.nearCap).map((store) => ({ store: store.storeName, chats: store.chats, cap: store.cap })),
          flaggedDay: sample.day,
          flagged: flagged.map((row) => ({ conversationId: row.id, kind: row.kind, store: row.storeName, reasons: row.reasons })),
        };
      }),
    }),

    catalogue_queues: tool({
      description: "Catalogue work waiting: products needing review, store product proposals, attribute proposals and duplicate pairs.",
      inputSchema: z.object({}),
      execute: () => audited(ctx, "catalogue_queues", {}, async () => {
        const [stats, proposals, attributes, duplicates] = await Promise.all([
          getReviewStats(),
          listProductProposals(),
          listAttributeProposals(),
          listDuplicatePairs(),
        ]);
        link(book, "Catalog review", "/admin/catalog/review");
        link(book, "Duplicates", "/admin/catalog/duplicates");
        return {
          productsNeedingReview: stats.needsReview,
          productProposals: proposals.length,
          proposalsShown: proposals.slice(0, ROWS_MAX).map((row) => ({ name: row.name, store: row.storeName })),
          attributeProposals: attributes.length,
          attributeProducts: attributes.slice(0, ROWS_MAX).map((row) => {
            link(book, row.productName, `/admin/catalog/products/${row.productId}`);
            return row.productName;
          }),
          duplicatePairs: duplicates.length,
          pairsShown: duplicates.slice(0, ROWS_MAX).map((pair) => `${pair.a.name} / ${pair.b.name}`),
        };
      }),
    }),

    platform_totals: tool({
      description: "Platform orders, goods sales, refunds and net, and active stores, for store days from and to (YYYY-MM-DD, inclusive, at most 366 days).",
      inputSchema: z.object({
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      }),
      execute: (input) => audited(ctx, "platform_totals", input, async () => {
        const totals = await platformTotals(input.from, input.to, ctx.now);
        if (!totals.ok) return totals;
        link(book, "Search orders", "/admin/orders/search");
        return {
          ok: true,
          from: totals.from,
          to: totals.to,
          orders: totals.orders,
          goodsSalesDollars: dollars(totals.goodsCents),
          refundsDollars: dollars(totals.refundsCents),
          netToStoresDollars: dollars(totals.netCents),
          storesWithOrders: totals.storesWithOrders,
          activeStoresNow: totals.activeStores,
        };
      }),
    }),
  };
}
