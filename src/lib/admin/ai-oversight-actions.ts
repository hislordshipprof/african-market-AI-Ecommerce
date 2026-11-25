"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { platformAdminTransaction } from "../db";
import { parseInput } from "../security/parse-input";
import { CONVERSATION_KINDS, REVIEW_LABELS } from "./ai-review";
import { requirePlatformAdmin } from "./session";

const labelSchema = z.strictObject({
  kind: z.enum(CONVERSATION_KINDS),
  conversationId: z.string().min(1).max(200),
  label: z.enum(REVIEW_LABELS),
  note: z.string().max(1000),
});

type Result = { ok: true } | { ok: false; error: string };

const ENTITY_TYPE = { shopper: "ai_conversation", copilot: "copilot_conversation", admin: "admin_assistant_conversation" } as const;

/**
 * A platform admin's review label on one conversation. The flag takes the conversation's own store id, never one from
 * the caller (none for a platform admin assistant chat), and the audit row names the label but not the note.
 */
export async function labelConversationAction(input: unknown): Promise<Result> {
  const session = await requirePlatformAdmin();
  const parsed = parseInput(labelSchema, input);
  if (!parsed.ok) return { ok: false, error: "Pick a label and keep the note to 1000 characters." };
  const { kind, conversationId, label } = parsed.data;
  const note = parsed.data.note.trim();

  const saved = await platformAdminTransaction(async (tx) => {
    const conversation = kind === "shopper"
      ? await tx.aiConversation.findUnique({ where: { id: conversationId }, select: { id: true, storeId: true } })
      : kind === "copilot"
        ? await tx.copilotConversation.findUnique({ where: { id: conversationId }, select: { id: true, storeId: true } })
        : await tx.adminAssistantConversation.findUnique({ where: { id: conversationId }, select: { id: true } })
          .then((row) => row && { id: row.id, storeId: null });
    if (!conversation) return false;
    const flag = await tx.aiReviewFlag.create({
      data: {
        storeId: conversation.storeId,
        ...(kind === "shopper" ? { aiConversationId: conversation.id }
          : kind === "copilot" ? { copilotConversationId: conversation.id }
          : { adminAssistantConversationId: conversation.id }),
        label,
        note,
        createdById: session.user.id,
      },
    });
    await tx.auditLog.create({
      data: {
        storeId: conversation.storeId,
        actorId: session.user.id,
        actorEmail: session.user.email,
        action: "ai_conversation.label",
        entityType: ENTITY_TYPE[kind],
        entityId: conversation.id,
        after: { flagId: flag.id, label },
      },
    });
    return true;
  });
  if (!saved) return { ok: false, error: "That conversation is no longer stored. Chats are deleted after 90 days." };

  revalidatePath("/admin/ai/conversations", "layout");
  return { ok: true };
}
