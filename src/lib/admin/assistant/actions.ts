"use server";

import { z } from "zod";
import { parseInput } from "@/lib/security/parse-input";
import { FIXED_ERROR, MESSAGE_MAX } from "../../copilot/types";
import { requirePlatformAdmin } from "../session";
import { loadAdminAssistantChat, sendAdminAssistantTurn } from "./turn";
import { confirmAdminDraft, rejectAdminDraft, type AdminDraftCard, type AdminDraftResult } from "./drafts";
import type { AdminAssistantResult } from "./types";

const sendSchema = z.strictObject({
  conversationId: z.string().min(1).max(200).optional(),
  messageId: z.string().min(1).max(200),
  text: z.string().max(MESSAGE_MAX),
});

/** A signed-in platform admin with 2FA sends one typed or spoken (already transcribed) message. */
export async function sendAdminAssistantMessage(input: unknown): Promise<AdminAssistantResult> {
  const session = await requirePlatformAdmin();
  const parsed = parseInput(sendSchema, input);
  if (!parsed.ok) return { ok: false, code: "invalid_request", message: "Write a message of 1,000 characters or less." };
  try {
    return await sendAdminAssistantTurn({ actor: { id: session.user.id, email: session.user.email }, ...parsed.data });
  } catch (error) {
    console.error("[admin-assistant] send failed", { errorType: error instanceof Error ? error.name : "Error" });
    return { ok: false, code: "copilot_unavailable", message: FIXED_ERROR };
  }
}

export async function loadAdminAssistant(): ReturnType<typeof loadAdminAssistantChat> {
  const session = await requirePlatformAdmin();
  return loadAdminAssistantChat(session.user.id);
}

const confirmSchema = z.strictObject({
  draftId: z.string().min(1).max(200),
  text: z.string().max(1000).optional(),
  keep: z.array(z.string().min(1).max(200)).max(20).optional(),
});

/** The admin's one tap on a draft card. 2FA is checked here, before the admin's own function runs. */
export async function confirmAdminAssistantDraft(input: unknown): Promise<AdminDraftResult> {
  const session = await requirePlatformAdmin();
  const parsed = parseInput(confirmSchema, input);
  if (!parsed.ok) return { ok: false, code: "invalid", message: "Check the text on the card and try again." };
  return confirmAdminDraft(parsed.data.draftId, { id: session.user.id, email: session.user.email }, { text: parsed.data.text, keep: parsed.data.keep });
}

export async function rejectAdminAssistantDraft(input: unknown): Promise<{ ok: true; draft: AdminDraftCard } | { ok: false; code: "not_found"; message: string }> {
  const session = await requirePlatformAdmin();
  const parsed = parseInput(z.strictObject({ draftId: z.string().min(1).max(200) }), input);
  if (!parsed.ok) return { ok: false, code: "not_found", message: "That draft is no longer waiting." };
  return rejectAdminDraft(parsed.data.draftId, { id: session.user.id, email: session.user.email });
}
