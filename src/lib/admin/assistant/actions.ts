"use server";

import { z } from "zod";
import { parseInput } from "../../security/parse-input";
import { FIXED_ERROR, MESSAGE_MAX } from "../../copilot/types";
import { requirePlatformAdmin } from "../session";
import { loadAdminAssistantChat, sendAdminAssistantTurn } from "./turn";
import type { AdminAssistantMessage, AdminAssistantResult } from "./types";

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

export async function loadAdminAssistant(): Promise<{ conversationId: string | null; messages: AdminAssistantMessage[] }> {
  const session = await requirePlatformAdmin();
  return loadAdminAssistantChat(session.user.id);
}
