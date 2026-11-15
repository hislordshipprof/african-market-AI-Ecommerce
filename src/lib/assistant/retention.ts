import { randomUUID } from "node:crypto";
import { deleteExpiredAssistantActions, deleteExpiredAssistantConversations, deleteExpiredReviewFlags } from "../db";

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
/** Review flags are a few per day, made by hand; 50 batches of 1000 is ample. */
const FLAG_BATCHES = 50;

export interface AssistantStep {
  run<T>(id: string, fn: () => Promise<T> | T): Promise<T>;
}

export interface RetentionResult {
  actionsDeleted: number;
  conversationsDeleted: number;
  flagsDeleted: number;
}

/**
 * Deletes shopper transcripts strictly older than 90 days, then AI review flags (#544) older than 90 days.
 * A shopper conversation's flags go with it by foreign key.
 * The clock is read only inside the cutoff step. Dates are bound parameters
 * against timestamp(3) columns, so the session TimeZone cannot move the cutoff.
 */
export async function runAssistantRetention(
  step: AssistantStep,
  options?: { batchSize?: number; maxBatches?: number },
): Promise<RetentionResult> {
  const batchSize = options?.batchSize ?? 1000;
  const maxBatches = options?.maxBatches ?? 400;
  if (1 + maxBatches * 2 + FLAG_BATCHES > 1000) {
    throw new Error("assistant retention step ceiling");
  }
  const bounds = await step.run("cutoff", async () => {
    const now = new Date(Date.now());
    return {
      now: now.toISOString(),
      cutoff: new Date(now.getTime() - NINETY_DAYS_MS).toISOString(),
      runId: randomUUID(),
    };
  });
  const now = naiveTimestamp(bounds.now);
  const cutoff = naiveTimestamp(bounds.cutoff);
  const actionsDeleted = await deleteInBatches(
    step,
    "delete-actions",
    "ai_actions",
    batchSize,
    maxBatches,
    (batch) => deleteExpiredAssistantActions(cutoff, batchSize, `${bounds.runId}:actions:${batch}`),
  );
  const conversationsDeleted = await deleteInBatches(
    step,
    "delete-conversations",
    "ai_conversations",
    batchSize,
    maxBatches,
    (batch) => deleteExpiredAssistantConversations(cutoff, now, batchSize, `${bounds.runId}:conversations:${batch}`),
  );
  const flagsDeleted = await deleteInBatches(
    step,
    "delete-review-flags",
    "ai_review_flags",
    batchSize,
    FLAG_BATCHES,
    (batch) => deleteExpiredReviewFlags(cutoff, batchSize, `${bounds.runId}:flags:${batch}`),
  );
  return { actionsDeleted, conversationsDeleted, flagsDeleted };
}

/** UTC clock time with no zone, so timestamp(3) comparison ignores the session TimeZone. */
function naiveTimestamp(iso: string): string {
  return iso.replace("T", " ").replace(/Z$/, "");
}

async function deleteInBatches(
  step: AssistantStep,
  stepId: string,
  table: string,
  batchSize: number,
  maxBatches: number,
  deleteBatch: (batch: number) => Promise<number>,
): Promise<number> {
  let total = 0;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const count = await step.run(`${stepId}:${batch}`, async () => deleteBatch(batch));
    total += count;
    if (count < batchSize) return total;
  }
  console.error(`[assistant-retention] batch cap reached ${table}`);
  return total;
}
