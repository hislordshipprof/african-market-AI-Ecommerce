import { tool } from "ai";
import { z } from "zod";
import { platformAdmin, platformAdminTransaction } from "../../db";
import { COURIER_SELECTION_MODES, ASSIGNMENT_TIMEOUT_SECONDS, COURIER_WEIGHT_LIMIT_LB, readCourierSettings } from "../../delivery/courier-settings";
import { ownerInvite } from "../../invite/service";
import { applicationChecks } from "../../store-application/checks";
import { REJECT_REASON_MAX } from "../../store-application/fields";
import { listStoreApplications } from "../../store-application/service";
import { listStores, getStoreSubscription } from "../actions";
import { conversationHref, REVIEW_LABELS, REVIEW_LABEL_TEXT } from "../ai-review";
import { getCourierIncident } from "../courier-incidents";
import { NOTE_MAX } from "../courier-incidents-query";
import { listMetros } from "../metros";
import { pendingDraft, type AdminDraftKind, type DraftChange, type DraftView } from "./drafts";
import { ROWS_MAX } from "./types";
import { audited, link, type ToolContext } from "./tools";

const NOTE = "Drafted. Nothing changes until the admin confirms the card on screen.";
const SELECTION_TEXT: Record<(typeof COURIER_SELECTION_MODES)[number], string> = {
  cheapest: "Cheapest courier",
  doordash_first: "DoorDash first",
  uber_first: "Uber first",
};

const onOff = (value: boolean) => (value ? "On" : "Off");

async function storeBySlug(slug: string) {
  return (await listStores()).find((row) => row.slug === slug.trim().toLowerCase()) ?? null;
}

/** Adds the card to the turn and tells the model what it says. */
export async function addDraft<K extends AdminDraftKind>(
  ctx: ToolContext,
  kind: K,
  storeId: string | null,
  params: Parameters<typeof pendingDraft<K>>[2],
  view: DraftView,
) {
  ctx.book.drafts.push(await pendingDraft(kind, storeId, params, view));
  return {
    drafted: true,
    card: view.title,
    store: view.storeName,
    changes: view.changes.map((change) => `${change.field}: ${change.from} to ${change.to}`),
    ...(view.warning ? { warning: view.warning } : {}),
    ...(view.steps ? { steps: view.steps } : {}),
    ...(view.items ? { items: view.items.map((item) => item.label) } : {}),
    note: NOTE,
  };
}

export const refused = (reason: string) => ({ drafted: false, reason });

function threadStatus(thread: { state: string; lastCustomerAt: Date | null; lastReplyAt: Date | null }): string {
  if (thread.state === "resolved") return "Resolved";
  if (thread.lastReplyAt && (!thread.lastCustomerAt || thread.lastReplyAt >= thread.lastCustomerAt)) return "Answered, waiting on the customer";
  return "Waiting on the platform";
}

/** The draft-and-confirm tools (#832): each reads the record, then adds a card. The confirm calls the admin's own function. */
export function draftTools(ctx: ToolContext) {
  const { book } = ctx;
  return {
    check_applications: tool({
      description: "Check each waiting store application the way the approve screen would: missing details, duplicates of a store or another application, and whether a metro covers its state. Gives each application's id for draft_application_decision.",
      inputSchema: z.object({}),
      execute: () => audited(ctx, "check_applications", {}, async () => {
        const [{ pending }, stores, metros] = await Promise.all([listStoreApplications(), listStores(), listMetros()]);
        link(book, "Applications", "/admin/applications");
        return {
          waiting: pending.length,
          applications: pending.slice(0, ROWS_MAX).map((row) => ({
            applicationId: row.id,
            business: row.businessName,
            address: `${row.addressLine1}, ${row.city}, ${row.state} ${row.zip}`,
            ...applicationChecks(row, { stores, metros, pending }),
          })),
        };
      }),
    }),

    draft_application_decision: tool({
      description: "Draft approve or reject cards for waiting store applications, one per application. Approve needs the store slug (lowercase letters, numbers, hyphens); reject needs the internal reason, which the applicant never sees.",
      inputSchema: z.object({
        decisions: z.array(z.object({
          applicationId: z.string().min(1).max(64),
          decision: z.enum(["approve", "reject"]),
          slug: z.string().max(80).optional(),
          reason: z.string().max(REJECT_REASON_MAX).optional(),
        })).min(1).max(10),
      }),
      execute: (input) => audited(ctx, "draft_application_decision", input, async () => {
        const results = [];
        for (const decision of input.decisions) {
          const application = await platformAdmin.storeApplication.findUnique({ where: { id: decision.applicationId } });
          if (!application || application.status !== "pending") {
            results.push(refused("That application is not waiting for a decision."));
            continue;
          }
          link(book, "Applications", "/admin/applications");
          const base = { storeName: application.businessName, href: "/admin/applications" };
          if (decision.decision === "approve") {
            const slug = (decision.slug ?? "").trim().toLowerCase();
            results.push(await addDraft(ctx, "application_approve", null, { applicationId: application.id, slug }, {
              ...base,
              title: "Approve store application",
              changes: [{ field: "Application", from: "Waiting", to: "Approved, store in setup" }],
              editable: { label: "Store slug", text: slug, max: 80 },
              warning: `Creates the store and emails the owner invite to ${application.email}. This cannot be undone.`,
            }));
          } else {
            const reason = (decision.reason ?? "").trim();
            results.push(await addDraft(ctx, "application_reject", null, { applicationId: application.id, reason }, {
              ...base,
              title: "Reject store application",
              changes: [{ field: "Application", from: "Waiting", to: "Rejected" }],
              editable: { label: "Reason (the applicant never sees it)", text: reason, max: REJECT_REASON_MAX },
              warning: `Emails ${application.email} that the application was not accepted. This cannot be undone.`,
            }));
          }
        }
        return { results };
      }),
    }),

    draft_store_status: tool({
      description: "Draft suspending a store, or reactivating a suspended one, by its slug.",
      inputSchema: z.object({ slug: z.string().min(1).max(100), status: z.enum(["suspended", "active"]) }),
      execute: (input) => audited(ctx, "draft_store_status", input, async () => {
        const store = await storeBySlug(input.slug);
        if (!store) return refused("No store has that slug.");
        if (store.status === input.status) return refused(`The store is already ${store.status}.`);
        if (input.status === "active" && store.status !== "suspended") return refused("Only a suspended store can be reactivated; a store in setup goes live from its checklist.");
        link(book, store.name, `/admin/stores/${store.id}`);
        return addDraft(ctx, "store_status", store.id, { storeId: store.id, status: input.status }, {
          title: input.status === "suspended" ? "Suspend store" : "Reactivate store",
          storeName: store.name,
          changes: [{ field: "Status", from: store.status, to: input.status === "suspended" ? "suspended" : "back to before the suspension" }],
          editable: null,
          warning: input.status === "suspended" ? "Shoppers can no longer order from this store." : null,
          href: `/admin/stores/${store.id}`,
        });
      }),
    }),

    draft_plan_override: tool({
      description: "Draft a time-boxed plan override for a store: the plan (starter or pro), the end date (YYYY-MM-DD) and the reason.",
      inputSchema: z.object({
        slug: z.string().min(1).max(100),
        plan: z.enum(["starter", "pro"]),
        endsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        reason: z.string().max(500),
      }),
      execute: (input) => audited(ctx, "draft_plan_override", input, async () => {
        const store = await storeBySlug(input.slug);
        if (!store) return refused("No store has that slug.");
        const subscription = await getStoreSubscription(store.id);
        if (!subscription) return refused("This store has no billing record yet.");
        link(book, store.name, `/admin/stores/${store.id}`);
        const reason = input.reason.trim();
        return addDraft(ctx, "plan_override", store.id, { storeId: store.id, plan: input.plan, endsOn: input.endsOn, reason }, {
          title: "Plan override",
          storeName: store.name,
          changes: [
            { field: "Plan", from: subscription.plan, to: input.plan },
            { field: "Override ends", from: subscription.overrideEndsAt ? subscription.overrideEndsAt.toISOString().slice(0, 10) : "No override", to: input.endsOn },
          ],
          editable: { label: "Reason", text: reason, max: 500 },
          warning: null,
          href: `/admin/stores/${store.id}`,
        });
      }),
    }),

    draft_pilot: tool({
      description: "Draft granting or removing a store's pilot offer (free months; a few stores at most).",
      inputSchema: z.object({ slug: z.string().min(1).max(100), pilot: z.boolean() }),
      execute: (input) => audited(ctx, "draft_pilot", input, async () => {
        const store = await storeBySlug(input.slug);
        if (!store) return refused("No store has that slug.");
        const subscription = await getStoreSubscription(store.id);
        if (!subscription) return refused("This store has no billing record yet.");
        if (subscription.pilot === input.pilot) return refused(`The pilot offer is already ${onOff(input.pilot).toLowerCase()}.`);
        link(book, store.name, `/admin/stores/${store.id}`);
        return addDraft(ctx, "pilot", store.id, { storeId: store.id, pilot: input.pilot }, {
          title: input.pilot ? "Grant pilot offer" : "Remove pilot offer",
          storeName: store.name,
          changes: [{ field: "Pilot offer", from: onOff(subscription.pilot), to: onOff(input.pilot) }],
          editable: null,
          warning: null,
          href: `/admin/stores/${store.id}`,
        });
      }),
    }),

    draft_store_metro: tool({
      description: "Draft putting a store in a metro by the metro's name, or in no metro (metro omitted).",
      inputSchema: z.object({ slug: z.string().min(1).max(100), metro: z.string().max(60).optional() }),
      execute: (input) => audited(ctx, "draft_store_metro", input, async () => {
        const [store, metros] = await Promise.all([storeBySlug(input.slug), listMetros()]);
        if (!store) return refused("No store has that slug.");
        const target = input.metro ? metros.find((metro) => metro.name.toLowerCase() === input.metro!.trim().toLowerCase()) : null;
        if (input.metro && !target) return refused(`No metro has that name. Metros: ${metros.map((metro) => metro.name).join(", ") || "none"}.`);
        if ((target?.id ?? null) === store.metroId) return refused("The store is already in that metro.");
        link(book, store.name, `/admin/stores/${store.id}`);
        return addDraft(ctx, "store_metro", store.id, { storeId: store.id, metroId: target?.id ?? null }, {
          title: "Store metro",
          storeName: store.name,
          changes: [{ field: "Metro", from: metros.find((metro) => metro.id === store.metroId)?.name ?? "None", to: target?.name ?? "None" }],
          editable: null,
          warning: null,
          href: `/admin/stores/${store.id}`,
        });
      }),
    }),

    draft_courier_retry: tool({
      description: "Draft queueing a store's DoorDash and Uber registration again, after a registration error.",
      inputSchema: z.object({ slug: z.string().min(1).max(100) }),
      execute: (input) => audited(ctx, "draft_courier_retry", input, async () => {
        const store = await storeBySlug(input.slug);
        if (!store) return refused("No store has that slug.");
        link(book, store.name, `/admin/stores/${store.id}`);
        const state = (error: string | null, registered: boolean) => error ?? (registered ? "Registered" : "Not registered");
        return addDraft(ctx, "courier_retry", store.id, { storeId: store.id }, {
          title: "Retry courier registration",
          storeName: store.name,
          changes: [
            { field: "DoorDash", from: state(store.doordashRegistrationError, Boolean(store.doordashStoreId)), to: "Queued again" },
            { field: "Uber", from: state(store.uberRegistrationError, Boolean(store.uberLocationId)), to: "Queued again" },
          ],
          editable: null,
          warning: null,
          href: `/admin/stores/${store.id}`,
        });
      }),
    }),

    draft_owner_invite: tool({
      description: "Draft emailing a store owner invite to an email address. A newer invite replaces the earlier link.",
      inputSchema: z.object({ slug: z.string().min(1).max(100), email: z.email().max(320) }),
      execute: (input) => audited(ctx, "draft_owner_invite", input, async () => {
        const store = await storeBySlug(input.slug);
        if (!store) return refused("No store has that slug.");
        const invite = await ownerInvite(store.id);
        const email = input.email.trim().toLowerCase();
        link(book, store.name, `/admin/stores/${store.id}`);
        return addDraft(ctx, "owner_invite", store.id, { storeId: store.id, email }, {
          title: "Invite store owner",
          storeName: store.name,
          changes: [{ field: "Owner invite", from: invite ? `${invite.email} (${invite.status})` : "None", to: email }],
          editable: null,
          warning: `Emails an invite to ${email}. This cannot be unsent.`,
          href: `/admin/stores/${store.id}`,
        });
      }),
    }),

    draft_courier_settings: tool({
      description: `Draft a change to the platform courier settings; give only the fields that change. selectionMode is ${COURIER_SELECTION_MODES.join(", ")}; assignmentTimeoutSeconds ${ASSIGNMENT_TIMEOUT_SECONDS.min} to ${ASSIGNMENT_TIMEOUT_SECONDS.max}; weightLimitLb ${COURIER_WEIGHT_LIMIT_LB.min} to ${COURIER_WEIGHT_LIMIT_LB.max}.`,
      inputSchema: z.object({
        selectionMode: z.enum(COURIER_SELECTION_MODES).optional(),
        assignmentTimeoutSeconds: z.number().int().optional(),
        weightLimitLb: z.number().int().optional(),
        doordashEnabled: z.boolean().optional(),
        uberEnabled: z.boolean().optional(),
      }),
      execute: (input) => audited(ctx, "draft_courier_settings", input, async () => {
        const current = await readCourierSettings();
        const next = { ...current, ...Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) };
        const show: Record<keyof typeof current, [string, (value: never) => string]> = {
          selectionMode: ["Courier choice", (value: (typeof COURIER_SELECTION_MODES)[number]) => SELECTION_TEXT[value]],
          assignmentTimeoutSeconds: ["Assignment timeout", (value: number) => `${value} seconds`],
          weightLimitLb: ["Weight limit", (value: number) => `${value} lb`],
          doordashEnabled: ["DoorDash", onOff],
          uberEnabled: ["Uber", onOff],
        };
        const changes: DraftChange[] = (Object.keys(show) as Array<keyof typeof current>)
          .filter((key) => next[key] !== current[key])
          .map((key) => ({ field: show[key][0], from: show[key][1](current[key] as never), to: show[key][1](next[key] as never) }));
        if (changes.length === 0) return refused("Those are the settings already.");
        link(book, "Courier settings", "/admin/settings/couriers");
        return addDraft(ctx, "courier_settings", null, next, {
          title: "Platform courier settings",
          storeName: null,
          changes,
          editable: null,
          warning: "Applies to every store's next delivery.",
          href: "/admin/settings/couriers",
        });
      }),
    }),

    draft_incident_note: tool({
      description: "Draft a note on a courier incident, by the incident's orderId from courier_incidents.",
      inputSchema: z.object({ orderId: z.string().min(1).max(200), note: z.string().max(NOTE_MAX) }),
      execute: (input) => audited(ctx, "draft_incident_note", input, async () => {
        const incident = (await getCourierIncident(input.orderId))?.incident;
        if (!incident) return refused("This order has no courier incident.");
        const body = input.note.trim();
        link(book, `Order ${incident.orderNumber}, ${incident.storeName}`, `/admin/couriers/incidents/${input.orderId}`);
        return addDraft(ctx, "incident_note", incident.storeId, { orderId: input.orderId, body }, {
          title: `Note on courier incident, order ${incident.orderNumber}`,
          storeName: incident.storeName,
          changes: [{ field: "Incident", from: incident.state, to: `${incident.state}, with a new note` }],
          editable: { label: "Note", text: body, max: NOTE_MAX },
          warning: null,
          href: `/admin/couriers/incidents/${input.orderId}`,
        });
      }),
    }),

    draft_conversation_label: tool({
      description: `Draft a review label on a flagged AI chat, by its conversationId and kind from ai_spend_and_flags. Labels: ${REVIEW_LABELS.join(", ")}.`,
      inputSchema: z.object({
        kind: z.enum(["shopper", "copilot"]),
        conversationId: z.string().min(1).max(200),
        label: z.enum(REVIEW_LABELS),
        note: z.string().max(1000),
      }),
      execute: (input) => audited(ctx, "draft_conversation_label", input, async () => {
        const conversation = await platformAdminTransaction((tx) => input.kind === "shopper"
          ? tx.aiConversation.findUnique({ where: { id: input.conversationId }, select: { id: true, store: { select: { id: true, name: true } } } })
          : tx.copilotConversation.findUnique({ where: { id: input.conversationId }, select: { id: true, store: { select: { id: true, name: true } } } }));
        if (!conversation) return refused("That chat is no longer stored.");
        const note = input.note.trim();
        const href = conversationHref(input.kind, input.conversationId);
        link(book, `${input.kind === "shopper" ? "Shopper" : "Copilot"} chat, ${conversation.store.name}`, href);
        return addDraft(ctx, "conversation_label", conversation.store.id, { ...input, note }, {
          title: `Label ${input.kind} AI chat`,
          storeName: conversation.store.name,
          changes: [{ field: "Review label", from: "None from you", to: REVIEW_LABEL_TEXT[input.label] }],
          editable: { label: "Note", text: note, max: 1000 },
          warning: null,
          href,
        });
      }),
    }),

    draft_support_reply: tool({
      description: "Draft the platform's reply on an escalated customer message, by its threadId from support_and_disputes. The admin reads and edits it; it is never sent until the admin confirms.",
      inputSchema: z.object({ threadId: z.string().min(1).max(200), reply: z.string().max(1000) }),
      execute: (input) => audited(ctx, "draft_support_reply", input, async () => {
        const thread = await platformAdminTransaction((tx) => tx.supportThread.findUnique({
          where: { id: input.threadId },
          select: { id: true, state: true, lastCustomerAt: true, lastReplyAt: true, store: { select: { id: true, name: true } }, order: { select: { number: true } } },
        }));
        if (!thread) return refused("That message thread was not found.");
        const body = input.reply.trim();
        const href = `/admin/support?selected=${thread.id}`;
        link(book, `Message on order ${thread.order.number}, ${thread.store.name}`, href);
        return addDraft(ctx, "support_reply", thread.store.id, { threadId: thread.id, body }, {
          title: `Reply to the customer on order ${thread.order.number}`,
          storeName: thread.store.name,
          changes: [{ field: "Thread", from: threadStatus(thread), to: "Replied by the platform team" }],
          editable: { label: "Reply", text: body, max: 1000 },
          warning: "The customer sees this reply. It cannot be unsent.",
          href,
        });
      }),
    }),
  };
}
