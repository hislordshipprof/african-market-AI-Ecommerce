"use server";

import { z } from "zod";
import { requireStoreOwner } from "../store-admin/session";
import { parseInput } from "../security/parse-input";
import { revalidateStorefront } from "../storefront/cache";
import { chooseListing } from "./choices";
import { confirmProposal, rejectProposal } from "./confirm";
import { sendCopilotTurn } from "./turn";
import {
  FIXED_ERROR,
  MESSAGE_MAX,
  type ChooseResult,
  type ConfirmResult,
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

const invalidRequest: SendResult = {
  ok: false,
  code: "invalid_request",
  message: "Write a stock report of 1,000 characters or less.",
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
