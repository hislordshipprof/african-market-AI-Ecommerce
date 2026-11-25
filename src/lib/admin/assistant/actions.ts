"use server";

import { z } from "zod";
import { parseInput } from "@/lib/security/parse-input";
import { FIXED_ERROR, MESSAGE_MAX } from "../../copilot/types";
import { requirePlatformAdmin } from "../session";
import { loadAdminAssistantChat, sendAdminAssistantTurn } from "./turn";
import { adminBriefing } from "./briefing";
import type { AdminBriefing } from "./briefing-view";
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

/** What the assistant sheet shows when it first opens (#855): the admin's own chat and today's briefing. */
export async function loadAdminAssistant(): Promise<Awaited<ReturnType<typeof loadAdminAssistantChat>> & { briefing: AdminBriefing }> {
  const session = await requirePlatformAdmin();
  const [chat, briefing] = await Promise.all([loadAdminAssistantChat(session.user.id), adminBriefing(new Date())]);
  return { ...chat, briefing };
}

const confirmSchema = z.strictObject({
  draftId: z.string().min(1).max(200),
  text: z.string().max(1000).optional(),
  keep: z.array(z.string().min(1).max(200)).max(20).optional(),
});

/** The admin's one tap on a draft card. 2FA is checked here, before the admin's own function runs. */
export async function confirmAdminAssistantDraft(input: unknown): Promise<AdminDraftResult> {
  const session = await requirePlatformAdmin();
  // A card with a photo is sent as a form; the photo itself is checked by the photo upload it goes to.
  const image = input instanceof FormData ? input.get("image") : null;
  const fields = input instanceof FormData ? formFields(input) : input;
  const parsed = parseInput(confirmSchema, fields);
  if (!parsed.ok) return { ok: false, code: "invalid", message: "Check the text on the card and try again." };
  return confirmAdminDraft(parsed.data.draftId, { id: session.user.id, email: session.user.email }, {
    text: parsed.data.text,
    keep: parsed.data.keep,
    ...(image instanceof File && image.size > 0 ? { image } : {}),
  });
}

function formFields(form: FormData): Record<string, unknown> {
  const text = (key: string) => (typeof form.get(key) === "string" ? (form.get(key) as string) : undefined);
  const keep = form.getAll("keep").filter((value): value is string => typeof value === "string");
  return {
    draftId: text("draftId"),
    ...(text("text") !== undefined ? { text: text("text") } : {}),
    ...(form.has("keep") ? { keep } : {}),
  };
}

export async function rejectAdminAssistantDraft(input: unknown): Promise<{ ok: true; draft: AdminDraftCard } | { ok: false; code: "not_found"; message: string }> {
  const session = await requirePlatformAdmin();
  const parsed = parseInput(z.strictObject({ draftId: z.string().min(1).max(200) }), input);
  if (!parsed.ok) return { ok: false, code: "not_found", message: "That draft is no longer waiting." };
  return rejectAdminDraft(parsed.data.draftId, { id: session.user.id, email: session.user.email });
}
