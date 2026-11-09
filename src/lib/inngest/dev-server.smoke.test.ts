import { afterAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { testPrismaClient } from "@/lib/test-prisma";
import { storeScoped } from "../db";
import { sendOrderAuthorized } from "./send";

const enabled = process.env.INNGEST_DEV_SMOKE === "1";
const devUrl = process.env.INNGEST_DEV_URL ?? "http://127.0.0.1:8288";
const SWEEP_SLUG = "african-markets-order/sweep-orphaned-authorized";

/**
 * Opt-in: start the app with INNGEST_DEV=1, then
 * `pnpm dlx inngest-cli@latest dev --no-discovery --host 127.0.0.1 --port 8288 -u http://localhost:3100/api/inngest`.
 * CLI 1.49 answers runs through POST /v0/gql. GET /v1/runs is 404.
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
    raw = testPrismaClient();
    const store = await raw.store.findUniqueOrThrow({ where: { slug: "mama-ngozi" } });
    const customer = await storeScoped(store.id).customer.findFirstOrThrow({ where: { storeId: store.id } });
    const order = await storeScoped(store.id).order.create({
      data: {
        storeId: store.id,
        number: 800000 + (Date.now() % 100000),
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
    const slugs = runs.map((run) => run.slug);
    expect(slugs).toEqual(
      expect.arrayContaining([
        "african-markets-order/acceptance-alert",
        "african-markets-order/auto-cancel",
      ]),
    );
    await Promise.all(runs.map((run) => cancelRun(run.id)));
  }, 40_000);

  it("an overlapping sweep is skipped", async () => {
    const before = new Date().toISOString();
    await Promise.all([invokeSweep(), invokeSweep()]);
    const runs = await waitForSweepRuns(before);
    expect(runs).toHaveLength(1);
  }, 20_000);
});

type DevRun = { id: string; slug: string; status: string };

async function waitForRuns(eventId: string): Promise<DevRun[]> {
  const deadline = Date.now() + 25_000;
  let internalId = "";
  while (Date.now() < deadline) {
    internalId = internalId || (await eventInternalId(eventId));
    if (internalId) {
      const runs = (await listRuns("2026-01-01T00:00:00Z")).filter((run) => run.triggerIDs.includes(internalId));
      const slugs = new Set(runs.map((run) => run.slug));
      if (slugs.has("african-markets-order/acceptance-alert") && slugs.has("african-markets-order/auto-cancel")) {
        return runs.map(({ id, slug, status }) => ({ id, slug, status }));
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Dev Server did not start both runs for ${eventId} (internal ${internalId || "missing"})`);
}

async function waitForSweepRuns(from: string): Promise<DevRun[]> {
  const deadline = Date.now() + 15_000;
  let seen: DevRun[] = [];
  while (Date.now() < deadline) {
    seen = (await listRuns(from))
      .filter((run) => run.slug === SWEEP_SLUG)
      .map(({ id, slug, status }) => ({ id, slug, status }));
    if (seen.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return (await listRuns(from))
        .filter((run) => run.slug === SWEEP_SLUG)
        .map(({ id, slug, status }) => ({ id, slug, status }));
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return seen;
}

type ListedRun = DevRun & { triggerIDs: string[] };

async function listRuns(from: string): Promise<ListedRun[]> {
  const body = await gql<{
    runs: { edges: { node: { id: string; status: string; triggerIDs: string[]; function: { slug: string } } }[] };
  }>(
    `query ($from: Time!) {
      runs(first: 50, orderBy: [{ field: QUEUED_AT, direction: DESC }], filter: { from: $from }) {
        edges { node { id status triggerIDs function { slug } } }
      }
    }`,
    { from },
  );
  return body.runs.edges.map((edge) => ({
    id: edge.node.id,
    status: edge.node.status,
    slug: edge.node.function.slug,
    triggerIDs: edge.node.triggerIDs,
  }));
}

async function eventInternalId(eventId: string): Promise<string> {
  const response = await fetch(`${devUrl}/v1/events`);
  if (!response.ok) return "";
  const body = (await response.json()) as { data?: { id?: string; internal_id?: string }[] };
  return body.data?.find((event) => event.id === eventId)?.internal_id ?? "";
}

async function invokeSweep(): Promise<void> {
  const body = await gql<{ invokeFunction: boolean }>(
    `mutation { invokeFunction(functionSlug: "${SWEEP_SLUG}", data: {}) }`,
  );
  expect(body.invokeFunction).toBe(true);
}

async function cancelRun(runId: string): Promise<void> {
  await gql(`mutation ($runID: ULID!) { cancelRun(runID: $runID) { id } }`, { runID: runId });
}

async function gql<T>(query: string, variables?: Record<string, string>): Promise<T> {
  const response = await fetch(`${devUrl}/v0/gql`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const body = (await response.json()) as { data?: T; errors?: { message: string }[] };
  if (!response.ok || body.errors?.length) {
    throw new Error(body.errors?.map((error) => error.message).join("; ") || `GraphQL ${response.status}`);
  }
  return body.data as T;
}
