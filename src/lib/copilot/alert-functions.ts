import { inngest } from "../inngest/client";
import { createOrderStockAlerts, pushCopilotAlerts } from "./alerts";

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
    const created = await step.run("create-alerts", () => createOrderStockAlerts(storeId, orderId));
    if (created > 0) await step.run("push-alerts", () => pushCopilotAlerts(storeId));
  },
);
