import { inngest } from "../inngest/client";
import { createConfirmRequests, createOrderStockAlerts, pushCopilotAlerts } from "./alerts";

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

/** After the daily confidence run: confirm-requests, then one capped push per store that got one. */
export async function runConfirmRequestSteps(step: { run<T>(id: string, fn: () => Promise<T>): Promise<unknown> }): Promise<void> {
  const stores = (await step.run("copilot-confirm-requests", () => createConfirmRequests())) as string[];
  for (const storeId of stores) {
    await step.run(`copilot-push-${storeId}`, () => pushCopilotAlerts(storeId));
  }
}
