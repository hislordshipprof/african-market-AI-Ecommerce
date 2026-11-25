"use server";

import { z } from "zod";
import { requireStoreOwner } from "../store-admin/session";
import { parseInput } from "../security/parse-input";
import { revalidateStorefront } from "../storefront/cache";
import { chooseListing } from "./choices";
import { answerAlert, confirmProposal, rejectProposal, type AnswerResult } from "./confirm";
import { sendCopilotTurn } from "./turn";
import { DRAFT_MAKERS, confirmDraft, rejectDraft, storeSite } from "./drafts";
import { revalidateStore } from "../get-store";
import { PAYOUTS_SHOWN, storePayouts } from "../payouts/service";
import {
  FIXED_ERROR,
  MESSAGE_MAX,
  QUANTITY_MAX,
  type ChooseResult,
  type ConfirmResult,
  type DraftConfirmResult,
  type RejectResult,
  type SendResult,
} from "./types";

const sendSchema = z.strictObject({
  conversationId: z.string().min(1).max(200).optional(),
  messageId: z.string().min(1).max(200),
  text: z.string().max(MESSAGE_MAX),
});

const proposalSchema = z.strictObject({
  proposalId: z.string().min(1).max(200),
});

const chooseSchema = z.strictObject({
  conversationId: z.string().min(1).max(200),
  messageId: z.string().min(1).max(200),
  listingId: z.string().min(1).max(200),
});

const couponFieldsSchema = z.strictObject({
  code: z.string().max(40),
  kind: z.enum(["percent", "fixed"]),
  percentOff: z.string().max(40),
  amountOff: z.string().max(40),
  minGoods: z.string().max(40),
  startsAt: z.string().max(40),
  endsAt: z.string().max(40),
  totalUses: z.string().max(40),
  usesPerCustomer: z.string().max(40),
  firstOrderOnly: z.string().max(40),
});

const draftConfirmSchema = z.strictObject({
  draftId: z.string().min(1).max(200),
  coupon: couponFieldsSchema.optional(),
  variantIds: z.array(z.string().min(1).max(200)).min(1).max(20).optional(),
});

const draftSchema = z.strictObject({ draftId: z.string().min(1).max(200) });

const DRAFT_FAILED: DraftConfirmResult = { ok: false, code: "not_found", message: FIXED_ERROR };

const answerSchema = z.discriminatedUnion("answer", [
  z.strictObject({
    alertId: z.string().min(1).max(200),
    answer: z.literal("still_have"),
    qty: z.number().int().min(0).max(QUANTITY_MAX),
  }),
  z.strictObject({ alertId: z.string().min(1).max(200), answer: z.literal("sold_out") }),
  z.strictObject({ alertId: z.string().min(1).max(200), answer: z.literal("in_stock") }),
]);

const invalidRequest: SendResult = {
  ok: false,
  code: "invalid_request",
  message: "Write a message of 1,000 characters or less.",
};

export async function sendCopilotMessage(input: unknown): Promise<SendResult> {
  const session = await requireStoreOwner();
  const parsed = parseInput(sendSchema, input);
  if (!parsed.ok) return invalidRequest;
  try {
    return await sendCopilotTurn({
      storeId: session.store.id,
      userId: session.user.id,
      email: session.user.email,
      conversationId: parsed.data.conversationId,
      messageId: parsed.data.messageId,
      text: parsed.data.text,
      payouts: { shown: PAYOUTS_SHOWN, list: storePayouts },
      drafts: DRAFT_MAKERS,
    });
  } catch (error) {
    console.error("[copilot] send failed", { errorType: error instanceof Error ? error.name : "Error" });
    return { ok: false, code: "copilot_unavailable", message: FIXED_ERROR };
  }
}

export async function confirmStockProposal(input: unknown): Promise<ConfirmResult> {
  const session = await requireStoreOwner();
  const parsed = parseInput(proposalSchema, input);
  if (!parsed.ok) return { ok: false, code: "not_found" };
  try {
    const result = await confirmProposal(session.store.id, parsed.data.proposalId, {
      id: session.user.id,
      email: session.user.email,
    });
    if (result.ok) revalidateStorefront(session.store.id);
    return result;
  } catch (error) {
    console.error("[copilot] confirm failed", { errorType: error instanceof Error ? error.name : "Error" });
    return { ok: false, code: "not_found" };
  }
}

export async function rejectStockProposal(input: unknown): Promise<RejectResult> {
  const session = await requireStoreOwner();
  const parsed = parseInput(proposalSchema, input);
  if (!parsed.ok) return { ok: false, code: "not_found" };
  try {
    return await rejectProposal(session.store.id, parsed.data.proposalId, {
      id: session.user.id,
      email: session.user.email,
    });
  } catch (error) {
    console.error("[copilot] dismiss failed", { errorType: error instanceof Error ? error.name : "Error" });
    return { ok: false, code: "not_found" };
  }
}

/** The owner taps one listing of a "Which one?" choice. Drafts a pending proposal; no model call. */
export async function chooseProposalListing(input: unknown): Promise<ChooseResult> {
  const session = await requireStoreOwner();
  const parsed = parseInput(chooseSchema, input);
  if (!parsed.ok) return { ok: false, code: "not_found" };
  try {
    return await chooseListing(session.store.id, { id: session.user.id, email: session.user.email }, parsed.data);
  } catch (error) {
    console.error("[copilot] choose failed", { errorType: error instanceof Error ? error.name : "Error" });
    return { ok: false, code: "not_found" };
  }
}

/** The owner's one-tap answer to a copilot alert: "Still have N", "Sold out" or "In stock". */
export async function answerCopilotAlert(input: unknown): Promise<AnswerResult> {
  const session = await requireStoreOwner();
  const parsed = parseInput(answerSchema, input);
  if (!parsed.ok) return { ok: false, code: "not_found" };
  const { alertId, ...answer } = parsed.data;
  try {
    const result = await answerAlert(session.store.id, alertId, answer, {
      id: session.user.id,
      email: session.user.email,
    });
    if (result.ok) revalidateStorefront(session.store.id);
    return result;
  } catch (error) {
    console.error("[copilot] answer failed", { errorType: error instanceof Error ? error.name : "Error" });
    return { ok: false, code: "not_found" };
  }
}

/** The owner confirms a coupon, price or store-change draft (#819), with the coupon terms or price lines as edited on the card. */
export async function confirmCopilotDraft(input: unknown): Promise<DraftConfirmResult> {
  const session = await requireStoreOwner();
  const parsed = parseInput(draftConfirmSchema, input);
  if (!parsed.ok) return DRAFT_FAILED;
  const { draftId, ...edits } = parsed.data;
  try {
    const result = await confirmDraft(session.store.id, draftId, { id: session.user.id, email: session.user.email }, edits);
    if (result.ok && result.draft.kind === "price") revalidateStorefront(session.store.id);
    if (result.ok && result.draft.kind === "store_change") {
      const site = await storeSite(session.store.id);
      if (site) revalidateStore(site);
    }
    return result;
  } catch (error) {
    console.error("[copilot] draft confirm failed", { errorType: error instanceof Error ? error.name : "Error" });
    return DRAFT_FAILED;
  }
}

export async function rejectCopilotDraft(input: unknown): Promise<RejectResult> {
  const session = await requireStoreOwner();
  const parsed = parseInput(draftSchema, input);
  if (!parsed.ok) return { ok: false, code: "not_found" };
  try {
    return await rejectDraft(session.store.id, parsed.data.draftId, { id: session.user.id, email: session.user.email });
  } catch (error) {
    console.error("[copilot] draft dismiss failed", { errorType: error instanceof Error ? error.name : "Error" });
    return { ok: false, code: "not_found" };
  }
}
