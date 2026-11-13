import {
  claimAssistantChatWarning,
  incrementAssistantChatMonth,
  platformAdmin,
  storeScoped,
  storeScopedTransaction,
} from "../db";
import { sendEmail } from "../email/send";
import { assistantChatCap, assistantChatWarnAt, effectivePlan, type Plan } from "./plan";

/** Shown to the shopper once the store's monthly chats are used up; browsing and checkout carry on. */
export const ASSISTANT_CAP_MESSAGE =
  "The shopping helper is not available right now. You can keep shopping by browsing the store.";

/** First day of the calendar month (UTC) the chat counts toward. */
export function chatMonth(at: Date): string {
  return `${at.toISOString().slice(0, 7)}-01`;
}

export type ChatClaim = { ok: true; chats: number; cap: number; plan: Plan } | { ok: false; cap: number; plan: Plan };

/**
 * Counts one shopper chat (one new message) against the store's monthly cap.
 * Refuses past the cap; the owner is emailed once when the month reaches 80%.
 */
export async function claimAssistantChat(storeId: string, at: Date): Promise<ChatClaim> {
  const month = chatMonth(at);
  const claim = await storeScopedTransaction(storeId, async (tx) => {
    const sub = await tx.storeSubscription.findUnique({ where: { storeId }, select: { plan: true, status: true } });
    const plan = effectivePlan(sub);
    const cap = assistantChatCap(plan);
    const chats = await incrementAssistantChatMonth(tx, storeId, month, cap);
    if (chats === null) return { ok: false as const, cap, plan };
    const warn = chats >= assistantChatWarnAt(plan) && (await claimAssistantChatWarning(tx, storeId, month));
    return { ok: true as const, chats, cap, plan, warn };
  });
  if (!claim.ok) return claim;
  if (claim.warn) await warnOwners(storeId, claim.chats, claim.cap, month);
  return { ok: true, chats: claim.chats, cap: claim.cap, plan: claim.plan };
}

/** This month's usage for the store-admin meter and banner. */
export async function assistantChatUsage(storeId: string, plan: Plan, at: Date = new Date()) {
  const row = await storeScoped(storeId).assistantChatMonth.findUnique({
    where: { storeId_month: { storeId, month: new Date(`${chatMonth(at)}T00:00:00Z`) } },
  });
  const cap = assistantChatCap(plan);
  const chats = row?.chats ?? 0;
  return { chats, cap, warning: chats >= assistantChatWarnAt(plan), capped: chats >= cap };
}

async function warnOwners(storeId: string, chats: number, cap: number, month: string): Promise<void> {
  const [store, owners] = await Promise.all([
    platformAdmin.store.findUnique({ where: { id: storeId }, select: { name: true } }),
    platformAdmin.storeMembership.findMany({
      where: { storeId, role: "owner" },
      select: { user: { select: { email: true } } },
    }),
  ]);
  console.warn(JSON.stringify({ event: "assistant_chat_cap_warning", storeId, chats, cap }));
  await Promise.allSettled(
    owners.map(({ user }) =>
      sendEmail({
        to: user.email,
        subject: `${store?.name ?? "Your store"}: ${chats.toLocaleString("en-US")} of ${cap.toLocaleString("en-US")} assistant chats used`,
        html: `<p>Your shoppers have used ${chats.toLocaleString("en-US")} of this month's ${cap.toLocaleString("en-US")} shopping-assistant chats. Past the limit the assistant pauses until next month and shoppers keep buying by browsing. The Pro plan includes ${assistantChatCap("pro").toLocaleString("en-US")} chats a month.</p>`,
        idempotencyKey: `assistant-cap-warning-${storeId}-${month}-${user.email}`,
      }),
    ),
  );
}
