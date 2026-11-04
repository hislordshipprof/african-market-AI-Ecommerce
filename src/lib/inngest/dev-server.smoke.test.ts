import { describe, expect, it } from "vitest";

const enabled = process.env.INNGEST_DEV_SMOKE === "1";
const devUrl = process.env.INNGEST_DEV_URL ?? "http://127.0.0.1:8288";

/**
 * Opt-in: INNGEST_DEV=1 and `npx --ignore-scripts=false inngest-cli@latest dev -u http://localhost:<port>/api/inngest`.
 * Places nothing by itself. The caller posts one order/authorized event through the Dev Server
 * and this test reads the runs that event started.
 */
describe.skipIf(!enabled)("Inngest Dev Server smoke", () => {
  it("an order starts acceptance and auto-cancel runs on the Dev Server", async () => {
    const orderId = `ord_smoke_${Date.now()}`;
    const eventId = `order-authorized-${orderId}`;
    const sent = await fetch(`${devUrl}/e/dev`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: eventId,
        name: "order/authorized",
        data: { storeId: "store_smoke", orderId, authorizedAt: new Date().toISOString() },
      }),
    });
    expect(sent.ok).toBe(true);

    const runs = await waitForRuns(eventId);
    const functionIds = runs.map((run) => run.function_id);
    expect(functionIds).toEqual(expect.arrayContaining(["order/acceptance-alert", "order/auto-cancel"]));
    expect(runs.every((run) => run.event_id === eventId || run.eventId === eventId)).toBe(true);
  }, 30_000);
});

type DevRun = { function_id: string; event_id?: string; eventId?: string };

async function waitForRuns(eventId: string): Promise<DevRun[]> {
  const deadline = Date.now() + 20_000;
  let last = "";
  while (Date.now() < deadline) {
    const response = await fetch(`${devUrl}/v1/events`);
    last = await response.text();
    if (response.ok && last.includes(eventId)) {
      const runsResponse = await fetch(`${devUrl}/v1/runs`);
      const body = await runsResponse.text();
      if (runsResponse.ok && body.includes("order/acceptance-alert") && body.includes("order/auto-cancel")) {
        const parsed = JSON.parse(body) as { data?: DevRun[] } | DevRun[];
        const runs = Array.isArray(parsed) ? parsed : parsed.data ?? [];
        const matched = runs.filter((run) => JSON.stringify(run).includes(eventId));
        if (matched.length >= 2) return matched;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Dev Server did not start both runs for ${eventId}. Last payload: ${last.slice(0, 500)}`);
}
