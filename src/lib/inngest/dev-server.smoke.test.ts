import { afterAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { storeScoped } from "../db";
import { sendOrderAuthorized } from "./send";

const enabled = process.env.INNGEST_DEV_SMOKE === "1";
const devUrl = process.env.INNGEST_DEV_URL ?? "http://127.0.0.1:8288";

/**
 * Opt-in: start the app with INNGEST_DEV=1, then
 * `pnpm dlx inngest-cli@latest dev --no-discovery --host 127.0.0.1 --port 8288 -u http://localhost:3100/api/inngest`.
 * Run with INNGEST_DEV=1 INNGEST_DEV_SMOKE=1.
 */
describe.skipIf(!enabled)("Inngest Dev Server smoke", () => {
  const created: string[] = [];
  let raw: PrismaClient | undefined;

  afterAll(async () => {
    if (!raw || created.length === 0) return;
    await raw.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await tx.order.deleteMany({ where: { id: { in: created } } });
    });
    await raw.$disconnect();
  });

  it("a real authorized order starts acceptance and auto-cancel on the Dev Server", async () => {
    raw = new PrismaClient({ adapter: new PrismaPg(process.env.DATABASE_URL!) });
    const store = await raw.store.findUniqueOrThrow({ where: { slug: "mama-ngozi" } });
    const customer = await storeScoped(store.id).customer.findFirstOrThrow({ where: { storeId: store.id } });
    const order = await storeScoped(store.id).order.create({
      data: {
        storeId: store.id,
        number: 18600 + Math.floor(Math.random() * 1000),
        customerId: customer.id,
        status: "AUTHORIZED",
        fulfillment: "pickup",
        subtotalCents: 1000,
        bufferCents: 100,
        totalAuthorizedCents: 1100,
        totalCents: 1000,
        paymentIntentId: `pi_smoke_${Date.now()}`,
      },
    });
    created.push(order.id);

    await sendOrderAuthorized(store.id, order.id);
    const sent = await storeScoped(store.id).order.findUnique({ where: { id: order.id } });
    expect(sent?.inngestEventSentAt).toBeTruthy();
    const eventId = `order-authorized-${order.id}`;
    const runs = await waitForRuns(eventId);
    const functionIds = runs.map((run) => run.function_id);
    expect(functionIds).toEqual(expect.arrayContaining(["order/acceptance-alert", "order/auto-cancel"]));
  }, 40_000);

  it("an overlapping sweep is skipped", async () => {
    const first = await invokeFunction("order/sweep-orphaned-authorized");
    const second = await invokeFunction("order/sweep-orphaned-authorized");
    const bodies = `${JSON.stringify(first)} ${JSON.stringify(second)}`;
    expect(bodies.toLowerCase()).toMatch(/skip/);
  }, 20_000);
});

type DevRun = { function_id: string; event_id?: string; eventId?: string; status?: string };

async function waitForRuns(eventId: string): Promise<DevRun[]> {
  const deadline = Date.now() + 25_000;
  const tried: string[] = [];
  while (Date.now() < deadline) {
    const listed = await fetch(`${devUrl}/v1/events`);
    const eventsBody = await listed.text();
    if (listed.ok && eventsBody.includes(eventId)) {
      for (const path of [
        `/v1/events/${encodeURIComponent(eventId)}/runs`,
        `/v1/events/${encodeURIComponent(eventId)}`,
      ]) {
        const response = await fetch(`${devUrl}${path}`);
        const body = await response.text();
        tried.push(`${path} ${response.status}`);
        if (!response.ok) continue;
        const runs = runsFrom(body).filter((run) => JSON.stringify(run).includes(eventId) || body.includes(eventId));
        const functionIds = new Set(runs.map((run) => run.function_id).filter(Boolean));
        if (functionIds.has("order/acceptance-alert") && functionIds.has("order/auto-cancel")) return runs;
        if (body.includes("order/acceptance-alert") && body.includes("order/auto-cancel") && body.includes(eventId)) {
          return [
            { function_id: "order/acceptance-alert", event_id: eventId },
            { function_id: "order/auto-cancel", event_id: eventId },
          ];
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Dev Server did not start both runs for ${eventId}. Tried ${tried.join(", ")}`);
}

function runsFrom(body: string): DevRun[] {
  const parsed = JSON.parse(body) as { data?: DevRun[]; runs?: DevRun[] } | DevRun[];
  if (Array.isArray(parsed)) return parsed;
  return parsed.data ?? parsed.runs ?? [];
}

async function invokeFunction(functionId: string): Promise<{ status: number; body: string }> {
  const response = await fetch(`${devUrl}/v1/fn/invoke`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ function_id: functionId }),
  });
  return { status: response.status, body: await response.text() };
}
