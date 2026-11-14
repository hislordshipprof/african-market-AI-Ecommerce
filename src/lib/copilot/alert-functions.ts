import { inngest } from "../inngest/client";
import { createConfirmRequestBatch, createOrderStockAlerts, pushCopilotAlerts, type ConfirmRequestBatchResult } from "./alerts";

/** Runs on the after-commit event, so stock is already reserved and a failure never touches checkout. */
export const copilotOrderStockAlerts = inngest.createFunction(
  {
    id: "copilot/order-stock-alerts",
    idempotency: "event.data.orderId",
    triggers: [{ event: "order/authorized" }],
  },
  async ({ event, step }) => {
    const { orderId, storeId } = event.data as { orderId?: string; storeId?: string };
    if (!orderId || !storeId) return;
    await step.run("create-alerts", () => createOrderStockAlerts(storeId, orderId));
    // Always: a retry after a committed write creates nothing, and its alerts still need the push.
    await step.run("push-alerts", () => pushCopilotAlerts(storeId));
  },
);

/** After the daily confidence run: confirm-requests, one step per page of stores. */
export async function runConfirmRequestSteps(step: {
  run(id: string, fn: () => Promise<ConfirmRequestBatchResult>): Promise<ConfirmRequestBatchResult>;
}): Promise<void> {
  let cursor: string | null = null;
  for (let batch = 0; ; batch += 1) {
    const previous: string | null = cursor;
    const page = await step.run(`copilot-confirm-requests-${batch}`, () => createConfirmRequestBatch(previous));
    if (page.nextCursor === null) return;
    cursor = page.nextCursor;
  }
}
