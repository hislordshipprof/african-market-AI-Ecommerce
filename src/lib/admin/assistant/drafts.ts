import { z } from "zod";
import { Prisma } from "@prisma/client";
import { platformAdmin, platformAdminTransaction } from "../../db";
import { setPilot, setPlanOverride } from "../../billing/service";
import { readCourierSettings, COURIER_SELECTION_MODES } from "../../delivery/courier-settings";
import { ownerInvite } from "../../invite/service";
import { approveStoreApplication, rejectStoreApplication } from "../../store-application/service";
import { REJECT_REASON_MAX } from "../../store-application/fields";
import { replyAsPlatformAction } from "../../support/platform-actions";
import { DRAFT_HOURS, WRITE_TRANSACTION } from "../../copilot/types";
import { inviteStoreOwnerAction, setStoreStatus } from "../actions";
import { labelConversationAction } from "../ai-oversight-actions";
import { REVIEW_LABELS } from "../ai-review";
import { addCourierIncidentNoteAction } from "../courier-incidents";
import { findCourierIncidents, NOTE_MAX } from "../courier-incidents-query";
import { saveCourierSettingsAction } from "../courier-settings-actions";
import { retryCourierRegistration } from "../courier-retry";
import { setStoreMetro } from "../metros";
import { WORKFLOW_KINDS } from "./workflow-kinds";

type Actor = { id: string; email: string };
type Json = Prisma.InputJsonValue;

/** One line of a card: what changes, from what to what. */
export interface DraftChange {
  field: string;
  from: string;
  to: string;
}

/** What the card shows, built when the tool drafts it. Every string is data from the records, never the model's own. */
export interface DraftView {
  title: string;
  storeName: string | null;
  changes: DraftChange[];
  /** The one text the admin may edit before confirming (a reply, a reason, a note, a slug). */
  editable: { label: string; text: string; max: number } | null;
  /** Set when the change cannot be taken back, such as an email that goes out. */
  warning: string | null;
  href: string | null;
  /** A workflow's steps, run in this order on confirm (#833). */
  steps?: string[];
  /** A batch's items, each with its problems; the admin unticks any to leave out (#833). */
  items?: DraftItem[];
}

export interface DraftItem {
  key: string;
  label: string;
  problems: string[];
}

export const DRAFT_STATES = ["pending", "applying", "confirmed", "rejected", "expired", "stale"] as const;
export type DraftState = (typeof DRAFT_STATES)[number];

export interface AdminDraftCard extends DraftView {
  id: string;
  kind: string;
  state: DraftState;
  expiresAt: string;
  /** What happened after the confirm, such as an invite email that did not send. */
  outcome: string | null;
}

/**
 * The confirm side of each draft kind. `params` is what the tool drafted; `snapshot` reads what the change depends on
 * now, so a card drafted against other values goes stale; `apply` calls the admin screen's own function.
 */
export interface Kind<P> {
  params: z.ZodType<P>;
  /** The params key the card's editable text goes into. */
  editKey?: keyof P & string;
  snapshot(params: P): Promise<Json>;
  apply(params: P, actor: Actor): Promise<{ ok: true; outcome?: string } | { ok: false; error: string }>;
}

const id = z.string().min(1).max(200);

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

async function storeRow(storeId: string) {
  return platformAdmin.store.findUnique({
    where: { id: storeId },
    select: { status: true, metroId: true, doordashRegistrationError: true, uberRegistrationError: true, doordashStoreId: true, uberLocationId: true },
  });
}

async function subscriptionRow(storeId: string) {
  return platformAdmin.storeSubscription.findUnique({
    where: { storeId },
    select: { pilot: true, overridePlan: true, overrideEndsAt: true, overrideReason: true },
  });
}

const applicationSnapshot = async ({ applicationId }: { applicationId: string }) => {
  const row = await platformAdmin.storeApplication.findUnique({ where: { id: applicationId }, select: { status: true } });
  return { status: row?.status ?? null };
};

const courierSettingsParams = z.strictObject({
  selectionMode: z.enum(COURIER_SELECTION_MODES),
  assignmentTimeoutSeconds: z.number().int(),
  weightLimitLb: z.number().int(),
  doordashEnabled: z.boolean(),
  uberEnabled: z.boolean(),
});

/** The only changes the assistant can draft. Anything else, whatever a draft row says, is refused at confirm. */
export const KINDS = {
  application_approve: {
    params: z.strictObject({ applicationId: id, slug: z.string().max(80) }),
    editKey: "slug",
    snapshot: applicationSnapshot,
    apply: async (p, actor) => {
      const result = await approveStoreApplication(p.applicationId, p.slug, actor);
      if (!result.ok) return result;
      return { ok: true, outcome: result.inviteEmailed ? "The store is in setup and the owner invite is on its way." : "The store is in setup. The invite email did not send: copy the link on the store page." };
    },
  } satisfies Kind<{ applicationId: string; slug: string }>,
  application_reject: {
    params: z.strictObject({ applicationId: id, reason: z.string().max(REJECT_REASON_MAX) }),
    editKey: "reason",
    snapshot: applicationSnapshot,
    apply: async (p, actor) => {
      const result = await rejectStoreApplication(p.applicationId, p.reason, actor);
      if (!result.ok) return result;
      return { ok: true, outcome: result.emailed ? "The applicant got a plain email without your reason." : "The email to the applicant did not send. Send it again on Applications." };
    },
  } satisfies Kind<{ applicationId: string; reason: string }>,
  store_status: {
    params: z.strictObject({ storeId: id, status: z.enum(["suspended", "active"]) }),
    snapshot: async (p) => ({ status: (await storeRow(p.storeId))?.status ?? null }),
    apply: async (p) => {
      const result = await setStoreStatus(p.storeId, p.status);
      return result.error ? { ok: false, error: result.error } : { ok: true };
    },
  } satisfies Kind<{ storeId: string; status: "suspended" | "active" }>,
  plan_override: {
    params: z.strictObject({ storeId: id, plan: z.enum(["starter", "pro"]), endsOn: z.iso.date(), reason: z.string().max(500) }),
    editKey: "reason",
    snapshot: async (p) => {
      const row = await subscriptionRow(p.storeId);
      return { overridePlan: row?.overridePlan ?? null, overrideEndsAt: row?.overrideEndsAt?.toISOString() ?? null, overrideReason: row?.overrideReason ?? null };
    },
    apply: (p, actor) => setPlanOverride({ storeId: p.storeId, plan: p.plan, endsAt: new Date(`${p.endsOn}T00:00:00Z`), reason: p.reason }, actor),
  } satisfies Kind<{ storeId: string; plan: "starter" | "pro"; endsOn: string; reason: string }>,
  pilot: {
    params: z.strictObject({ storeId: id, pilot: z.boolean() }),
    snapshot: async (p) => ({ pilot: (await subscriptionRow(p.storeId))?.pilot ?? null }),
    apply: (p, actor) => setPilot(p.storeId, p.pilot, actor),
  } satisfies Kind<{ storeId: string; pilot: boolean }>,
  store_metro: {
    params: z.strictObject({ storeId: id, metroId: id.nullable() }),
    snapshot: async (p) => ({ metroId: (await storeRow(p.storeId))?.metroId ?? null }),
    apply: async (p, actor) => (await platformAdminTransaction((tx) => setStoreMetro(tx, actor, p.storeId, p.metroId)))
      ? { ok: true }
      : { ok: false, error: "That store or metro no longer exists." },
  } satisfies Kind<{ storeId: string; metroId: string | null }>,
  courier_retry: {
    params: z.strictObject({ storeId: id }),
    snapshot: async (p) => {
      const row = await storeRow(p.storeId);
      return {
        doordash: row ? row.doordashRegistrationError ?? (row.doordashStoreId ? "registered" : null) : null,
        uber: row ? row.uberRegistrationError ?? (row.uberLocationId ? "registered" : null) : null,
      };
    },
    apply: async (p, actor) => {
      const outcome = await retryCourierRegistration(p.storeId, actor);
      if (outcome === "missing") return { ok: false, error: "Store not found" };
      return { ok: true, outcome: outcome === "queued" ? "Courier registration is queued again." : "The retry could not be queued. The daily retry will try again." };
    },
  } satisfies Kind<{ storeId: string }>,
  owner_invite: {
    params: z.strictObject({ storeId: id, email: z.email().max(320) }),
    snapshot: async (p) => {
      const invite = await ownerInvite(p.storeId);
      return { invite: invite ? { id: invite.id, status: invite.status } : null };
    },
    apply: async (p) => {
      const result = await inviteStoreOwnerAction(form({ storeId: p.storeId, email: p.email }));
      if ("error" in result && result.error) return { ok: false, error: result.error };
      return { ok: true, outcome: "warning" in result && result.warning ? "The invite email did not send. Copy the invite link on the store page." : `The owner invite went to ${p.email}.` };
    },
  } satisfies Kind<{ storeId: string; email: string }>,
  courier_settings: {
    params: courierSettingsParams,
    snapshot: async () => ({ ...(await readCourierSettings()) }),
    apply: async (p) => {
      const result = await saveCourierSettingsAction({}, form({
        selectionMode: p.selectionMode,
        assignmentTimeoutSeconds: String(p.assignmentTimeoutSeconds),
        weightLimitLb: String(p.weightLimitLb),
        ...(p.doordashEnabled ? { doordashEnabled: "on" } : {}),
        ...(p.uberEnabled ? { uberEnabled: "on" } : {}),
      }));
      if (result.saved) return { ok: true };
      return { ok: false, error: result.error ?? Object.values(result.fieldErrors ?? {})[0] ?? "Check the settings and try again." };
    },
  } satisfies Kind<z.infer<typeof courierSettingsParams>>,
  incident_note: {
    params: z.strictObject({ orderId: id, body: z.string().max(NOTE_MAX) }),
    editKey: "body",
    snapshot: async (p) => {
      const [incident] = (await platformAdminTransaction((tx) => findCourierIncidents(tx, { orderId: p.orderId }, 1))).rows;
      return { state: incident?.state ?? null };
    },
    apply: async (p) => {
      const result = await addCourierIncidentNoteAction({}, form({ orderId: p.orderId, body: p.body, intent: "note" }));
      if (result.saved) return { ok: true };
      return { ok: false, error: result.error ?? result.fieldErrors?.body ?? "Write a note." };
    },
  } satisfies Kind<{ orderId: string; body: string }>,
  conversation_label: {
    params: z.strictObject({ kind: z.enum(["shopper", "copilot"]), conversationId: id, label: z.enum(REVIEW_LABELS), note: z.string().max(1000) }),
    editKey: "note",
    snapshot: async (p) => {
      const where = p.kind === "shopper" ? { aiConversationId: p.conversationId } : { copilotConversationId: p.conversationId };
      return { labels: await platformAdminTransaction((tx) => tx.aiReviewFlag.count({ where })) };
    },
    apply: async (p) => {
      const result = await labelConversationAction(p);
      return result.ok ? { ok: true } : result;
    },
  } satisfies Kind<{ kind: "shopper" | "copilot"; conversationId: string; label: (typeof REVIEW_LABELS)[number]; note: string }>,
  support_reply: {
    params: z.strictObject({ threadId: id, body: z.string().max(1000) }),
    editKey: "body",
    snapshot: async (p) => {
      const thread = await platformAdminTransaction((tx) => tx.supportThread.findUnique({
        where: { id: p.threadId },
        select: { state: true, lastCustomerAt: true, lastReplyAt: true },
      }));
      if (!thread) return { thread: null };
      return { state: thread.state, lastCustomerAt: thread.lastCustomerAt?.toISOString() ?? "none", lastReplyAt: thread.lastReplyAt?.toISOString() ?? "none" };
    },
    apply: async (p) => {
      const result = await replyAsPlatformAction({ threadId: p.threadId, body: p.body });
      return result.ok ? { ok: true, outcome: "Your reply is on the thread." } : result;
    },
  } satisfies Kind<{ threadId: string; body: string }>,
  ...WORKFLOW_KINDS,
} as const;

export type AdminDraftKind = keyof typeof KINDS;

function kindOf(name: string): Kind<Record<string, unknown>> | null {
  return Object.hasOwn(KINDS, name) ? (KINDS[name as AdminDraftKind] as unknown as Kind<Record<string, unknown>>) : null;
}

/** A draft from one turn's tool, inserted with the turn. */
export interface PendingAdminDraft {
  kind: AdminDraftKind;
  storeId: string | null;
  params: Record<string, unknown>;
  before: Json;
  view: DraftView;
}

/** Reads what the confirm will compare against, so the card carries it from the moment it is drafted. */
export async function pendingDraft<K extends AdminDraftKind>(
  kind: K,
  storeId: string | null,
  params: z.infer<(typeof KINDS)[K]["params"]>,
  view: DraftView,
): Promise<PendingAdminDraft> {
  const entry = kindOf(kind)!;
  return { kind, storeId, params, before: await entry.snapshot(params), view };
}

interface Row {
  id: string;
  kind: string;
  payload: unknown;
  state: string;
  expiresAt: Date;
}

function payloadOf(value: unknown): { params: Record<string, unknown>; view: DraftView; outcome?: string } {
  return value as { params: Record<string, unknown>; view: DraftView; outcome?: string };
}

export function cardOf(row: Row, now: Date = new Date()): AdminDraftCard {
  const { view, outcome } = payloadOf(row.payload);
  const state = (DRAFT_STATES as readonly string[]).includes(row.state) ? (row.state as DraftState) : "stale";
  return {
    id: row.id,
    kind: row.kind,
    state: state === "pending" && row.expiresAt <= now ? "expired" : state,
    expiresAt: row.expiresAt.toISOString(),
    ...view,
    outcome: outcome ?? null,
  };
}

/** jsonb keeps keys in its own order, so values are compared with sorted keys. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

type Tx = Parameters<Parameters<typeof platformAdminTransaction>[0]>[0];

function audit(tx: Tx, actor: Actor, action: string, draft: { id: string; kind: string; storeId: string | null }, after: Record<string, unknown>) {
  return tx.auditLog.create({
    data: {
      ...(draft.storeId ? { storeId: draft.storeId } : {}),
      actorId: actor.id,
      actorEmail: actor.email,
      action,
      entityType: "admin_assistant_draft",
      entityId: draft.id,
      after: { kind: draft.kind, ...after } as Json,
    },
  });
}

/** Stores one turn's drafts, 24 hours to confirm, each with an `admin_assistant.draft_proposed` audit row. */
export async function insertAdminDrafts(
  tx: Tx,
  input: { userId: string; email: string; conversationId: string; messageId: string },
  drafts: readonly PendingAdminDraft[],
): Promise<AdminDraftCard[]> {
  const cards: AdminDraftCard[] = [];
  for (const draft of drafts) {
    const row = await tx.adminAssistantDraft.create({
      data: {
        userId: input.userId,
        conversationId: input.conversationId,
        clientMessageId: input.messageId,
        kind: draft.kind,
        storeId: draft.storeId,
        payload: { params: draft.params, view: draft.view } as unknown as Json,
        before: draft.before,
        state: "pending",
        expiresAt: new Date(Date.now() + DRAFT_HOURS * 3_600_000),
      },
    });
    await audit(tx, { id: input.userId, email: input.email }, "admin_assistant.draft_proposed", row, { params: draft.params, before: draft.before });
    cards.push(cardOf(row));
  }
  return cards;
}

/** The drafts of the admin's conversation, oldest first, keyed by the turn that drafted them. */
export async function loadAdminDraftCards(userId: string, conversationId: string): Promise<Record<string, AdminDraftCard[]>> {
  const rows = await platformAdminTransaction((tx) => tx.adminAssistantDraft.findMany({
    where: { userId, conversationId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  }));
  const byMessage: Record<string, AdminDraftCard[]> = {};
  for (const row of rows) (byMessage[row.clientMessageId] ??= []).push(cardOf(row));
  return byMessage;
}

export type AdminDraftResult =
  | { ok: true; draft: AdminDraftCard }
  | { ok: false; code: "not_found" | "expired" | "stale" | "refused" | "invalid" | "busy"; message: string };

const NOT_FOUND = { ok: false, code: "not_found", message: "That draft is no longer waiting. Ask again if you still need it." } as const;
const EXPIRED = { ok: false, code: "expired", message: "This draft expired after 24 hours. Ask again if you still need it." } as const;
const STALE = { ok: false, code: "stale", message: "This record changed since the draft was made, so nothing was applied. Ask again for a fresh draft." } as const;
const REFUSED = { ok: false, code: "refused", message: "The assistant cannot make this change." } as const;
const BUSY = { ok: false, code: "busy", message: "This draft is being applied." } as const;

/**
 * Applies a pending draft by calling the admin screen's own function. Refused when it is not this admin's, past
 * 24 hours, of a kind the assistant cannot make, or drafted against values that have changed since (it goes stale).
 * The caller has checked the platform admin session, 2FA included.
 */
export async function confirmAdminDraft(draftId: string, actor: Actor, edits: { text?: string } = {}): Promise<AdminDraftResult> {
  const now = new Date();
  const checked = await platformAdminTransaction(async (tx): Promise<AdminDraftResult | { row: Row & { storeId: string | null; before: unknown }; params: Record<string, unknown>; kind: Kind<Record<string, unknown>> }> => {
    const row = await tx.adminAssistantDraft.findUnique({ where: { id: draftId } });
    if (!row || row.userId !== actor.id) return NOT_FOUND;
    if (row.state === "confirmed") return { ok: true, draft: cardOf(row, now) };
    if (row.state === "applying") return BUSY;
    if (row.state === "expired") return EXPIRED;
    if (row.state !== "pending") return NOT_FOUND;
    if (row.expiresAt <= now) {
      await tx.adminAssistantDraft.update({ where: { id: draftId }, data: { state: "expired" } });
      return EXPIRED;
    }
    const kind = kindOf(row.kind);
    const payload = payloadOf(row.payload);
    const edited = kind?.editKey && edits.text !== undefined ? { ...payload.params, [kind.editKey]: edits.text.trim() } : payload.params;
    const params = kind?.params.safeParse(edited);
    if (!kind || !params?.success) {
      if (!kind) {
        await tx.adminAssistantDraft.update({ where: { id: draftId }, data: { state: "rejected", decidedById: actor.id, decidedAt: now } });
        await audit(tx, actor, "admin_assistant.draft_refused", row, { reason: "kind the assistant cannot make" });
        return REFUSED;
      }
      return { ok: false, code: "invalid", message: "Check the text on the card and try again." };
    }
    return { row, params: params.data, kind };
  }, WRITE_TRANSACTION);
  if ("ok" in checked) return checked;
  const { row, params, kind } = checked;

  if (canonical(await kind.snapshot(params)) !== canonical(row.before)) {
    await platformAdminTransaction(async (tx) => {
      const { count } = await tx.adminAssistantDraft.updateMany({ where: { id: draftId, state: "pending" }, data: { state: "stale" } });
      if (count > 0) await audit(tx, actor, "admin_assistant.draft_stale", row, {});
    });
    return STALE;
  }

  const claimed = await platformAdminTransaction((tx) => tx.adminAssistantDraft.updateMany({
    where: { id: draftId, state: "pending", expiresAt: { gt: new Date() } },
    data: { state: "applying", decidedById: actor.id, decidedAt: new Date() },
  }));
  if (claimed.count === 0) return NOT_FOUND;

  let applied: Awaited<ReturnType<Kind<Record<string, unknown>>["apply"]>>;
  try {
    applied = await kind.apply(params, actor);
  } catch (error) {
    await platformAdminTransaction((tx) => tx.adminAssistantDraft.update({ where: { id: draftId }, data: { state: "pending", decidedById: null, decidedAt: null } }));
    throw error;
  }
  if (!applied.ok) {
    await platformAdminTransaction((tx) => tx.adminAssistantDraft.update({ where: { id: draftId }, data: { state: "pending", decidedById: null, decidedAt: null } }));
    return { ok: false, code: "invalid", message: applied.error };
  }

  const view = payloadOf(row.payload).view;
  const editKey = kind.editKey;
  const shownView = editKey && view.editable ? { ...view, editable: { ...view.editable, text: String(params[editKey]) } } : view;
  const confirmed = await platformAdminTransaction(async (tx) => {
    const updated = await tx.adminAssistantDraft.update({
      where: { id: draftId },
      data: { state: "confirmed", payload: { params, view: shownView, ...(applied.outcome ? { outcome: applied.outcome } : {}) } as unknown as Json },
    });
    await audit(tx, actor, "admin_assistant.draft_confirmed", row, { params });
    return updated;
  });
  return { ok: true, draft: cardOf(confirmed) };
}

/** Dismisses a pending draft; nothing else is written. */
export async function rejectAdminDraft(draftId: string, actor: Actor): Promise<{ ok: true; draft: AdminDraftCard } | typeof NOT_FOUND> {
  return platformAdminTransaction(async (tx) => {
    const row = await tx.adminAssistantDraft.findUnique({ where: { id: draftId } });
    if (!row || row.userId !== actor.id) return NOT_FOUND;
    const { count } = await tx.adminAssistantDraft.updateMany({
      where: { id: draftId, state: "pending" },
      data: { state: "rejected", decidedById: actor.id, decidedAt: new Date() },
    });
    if (count === 0) return NOT_FOUND;
    await audit(tx, actor, "admin_assistant.draft_rejected", row, {});
    return { ok: true as const, draft: cardOf({ ...row, state: "rejected" }) };
  }, WRITE_TRANSACTION);
}
