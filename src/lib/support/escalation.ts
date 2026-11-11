import { inngest } from "../inngest/client";
import { blockInngestSend, devServerWithoutKey } from "../inngest/event-key";
import { platform, storeScoped, storeScopedTransaction } from "../db";
import { isValidTimezone, openMinutesDeadline } from "../order/store-hours";
import { scheduleAfterResponse } from "../schedule-after-response";

export const SUPPORT_MESSAGE_SENT = "support/message.sent";
const SEND_TIMEOUT_MS = 10_000;
/** Inside Inngest's 7-day Free-plan run limit, for a store whose hours never open in the week. */
const SLA_CAP_MS = (6 * 24 + 12) * 60 * 60_000;
/** Re-sleeps when edited hours push the deadline later; then the timer acts. */
const MAX_RESLEEPS = 3;

/** JSON-safe: Inngest serializes step.run results. */
type SlaPlan = { kind: "done" } | { kind: "act" } | { kind: "sleep"; deadlineIso: string };

type SlaStep = {
  run<T>(id: string, fn: () => Promise<T>): Promise<unknown>;
  sleepUntil(id: string, time: Date): Promise<unknown>;
};

/**
 * `supportSlaMinutes` open minutes after the message, never later than the cap.
 * An invalid zone falls back to wall-clock minutes, as the acceptance timer does.
 */
export function slaDeadline(sentAt: Date, store: { hours: unknown; timezone: string; supportSlaMinutes: number }): number {
  const cap = sentAt.getTime() + SLA_CAP_MS;
  if (!isValidTimezone(store.timezone)) {
    console.error(JSON.stringify({ event: "support_sla_invalid_timezone" }));
    return Math.min(sentAt.getTime() + store.supportSlaMinutes * 60_000, cap);
  }
  const open = openMinutesDeadline(store.hours, store.timezone, sentAt, store.supportSlaMinutes)?.getTime() ?? cap;
  return Math.min(open, cap);
}

async function unansweredMessage(storeId: string, messageId: string) {
  const message = await storeScoped(storeId).supportMessage.findUnique({
    where: { id: messageId },
    select: { createdAt: true, sender: true, thread: { select: { id: true, topic: true, state: true, lastReplyAt: true } } },
  });
  if (!message || message.sender !== "customer" || message.thread.topic !== "order") return null;
  if (message.thread.state !== "open") return null;
  if (message.thread.lastReplyAt && message.thread.lastReplyAt >= message.createdAt) return null;
  return message;
}

async function planSla(storeId: string, messageId: string, previousIso: string | null, iteration: number): Promise<SlaPlan> {
  const message = await unansweredMessage(storeId, messageId);
  if (!message) return { kind: "done" };
  const store = await platform.store.findUnique({
    where: { id: storeId },
    select: { hours: true, timezone: true, supportSlaMinutes: true },
  });
  if (!store) return { kind: "done" };
  const deadline = slaDeadline(message.createdAt, store);
  const previous = previousIso ? new Date(previousIso).getTime() : null;
  if (previous !== null && (deadline <= previous || iteration > MAX_RESLEEPS)) return { kind: "act" };
  if (deadline <= Date.now()) return { kind: "act" };
  return { kind: "sleep", deadlineIso: new Date(deadline).toISOString() };
}

/**
 * Escalates the order thread when no store or platform reply came after this message.
 * One conditional update, so a replay or a racing reply cannot escalate twice. True when it escalated.
 */
export async function escalateIfUnanswered(storeId: string, messageId: string): Promise<boolean> {
  const message = await unansweredMessage(storeId, messageId);
  if (!message) return false;
  return storeScopedTransaction(storeId, async (tx) => {
    const { count } = await tx.supportThread.updateMany({
      where: {
        id: message.thread.id,
        state: "open",
        OR: [{ lastReplyAt: null }, { lastReplyAt: { lt: message.createdAt } }],
      },
      data: { state: "escalated", escalatedAt: new Date(), escalationReason: "sla" },
    });
    return count === 1;
  });
}

/** The SLA timer for one customer message: plan, sleep to the deadline, re-plan on waking, then escalate. */
export async function runSlaTimer(step: SlaStep, storeId: string, messageId: string): Promise<boolean> {
  let previousIso: string | null = null;
  for (let i = 0; i <= MAX_RESLEEPS + 1; i++) {
    const plan = (await step.run(`sla-plan-${i}`, () => planSla(storeId, messageId, previousIso, i))) as SlaPlan;
    if (plan.kind === "done") return false;
    if (plan.kind === "act") {
      return (await step.run("sla-escalate", () => escalateIfUnanswered(storeId, messageId))) as boolean;
    }
    await step.sleepUntil(`sla-sleep-${i}`, new Date(plan.deadlineIso));
    previousIso = plan.deadlineIso;
  }
  return false;
}

export const supportSlaEscalation = inngest.createFunction(
  {
    id: "support/sla-escalation",
    idempotency: "event.data.messageId",
    triggers: [{ event: SUPPORT_MESSAGE_SENT }],
  },
  async ({ event, step }) => {
    const { storeId, messageId } = event.data as { storeId?: string; messageId?: string };
    if (!storeId || !messageId) return;
    await runSlaTimer(step, storeId, messageId);
  },
);

async function sendSupportMessageSent(storeId: string, messageId: string): Promise<void> {
  if (blockInngestSend()) return;
  const env = process.env;
  if (!env.INNGEST_EVENT_KEY && !devServerWithoutKey(env) && (env.NODE_ENV === "test" || env.CI === "true")) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("inngest send timed out")), SEND_TIMEOUT_MS);
  });
  const sendPromise = inngest.send({
    id: `support-message-${messageId}`,
    name: SUPPORT_MESSAGE_SENT,
    data: { storeId, messageId },
  });
  try {
    await Promise.race([sendPromise, timeout]);
  } catch (err) {
    void sendPromise.catch(() => undefined);
    const message = err instanceof Error ? err.message : "send failed";
    console.error(JSON.stringify({ event: "inngest_send_failed", messageId, message }));
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Starts the SLA timer after the response. A send failure is logged, never thrown to the customer. */
export function scheduleSlaTimer(storeId: string, messageId: string): void {
  scheduleAfterResponse(() => sendSupportMessageSent(storeId, messageId), "inngest_send_failed");
}
