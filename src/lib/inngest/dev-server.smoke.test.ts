import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { platformAdmin, platformAdminTransaction, storeScoped } from "../db";
import { placeOrder, computeQuote } from "../checkout/service";
import { getCheckoutPayments, resetFakeCheckoutPayments } from "../stripe/checkout-payments";

const enabled = process.env.INNGEST_DEV_SMOKE === "1";
const devUrl = process.env.INNGEST_DEV_URL ?? "http://127.0.0.1:8288";
const SWEEP_SLUG = "african-markets-order/sweep-orphaned-authorized";
const TIMERS = [
  { slug: "african-markets-order/acceptance-alert", name: "alert" },
  { slug: "african-markets-order/auto-cancel", name: "cancel" },
];

/**
 * Opt-in: start the app with INNGEST_DEV=1 and INNGEST_BASE_URL at the Dev Server, then
 * `pnpm dlx inngest-cli@latest dev --no-discovery --host 127.0.0.1 --port 8288 -u http://localhost:3100/api/inngest`.
 * CLI 1.49 answers runs through POST /v0/gql. GET /v1/runs is 404.
 * Run with INNGEST_DEV=1 INNGEST_DEV_SMOKE=1 (and INNGEST_BASE_URL / INNGEST_DEV_URL for another port).
 * Checkout uses the local fake Stripe, so no keys are needed.
 */
describe.skipIf(!enabled)("Inngest Dev Server smoke", () => {
  const run = `t473-smoke-${Date.now()}`;
  const contact = { name: "Ada", phone: "+15551234567", email: "ada@t473-smoke.test" };
  let storeId = "";
  let storeAccountId = "";
  let variantId = "";

  beforeAll(async () => {
    vi.stubEnv("E2E_FAKE_STRIPE", "1");
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("CI", "true");
    resetFakeCheckoutPayments();
    const store = await platformAdmin.store.create({
      data: {
        slug: run,
        name: "Smoke market",
        stripeAccountId: `acct_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
        stripeOnboardingStatus: "complete",
        pickupEnabled: true,
      },
    });
    storeId = store.id;
    storeAccountId = store.stripeAccountId!;
    const listing = await storeScoped(storeId).listing.create({
      data: { storeId, customName: "Smoke pack", price: 500, stockMode: "unlimited" },
    });
    variantId = (await storeScoped(storeId).listingVariant.create({
      data: { listingId: listing.id, label: "V", price: 500, weightG: 100 },
    })).id;
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    if (!storeId) return;
    const scoped = storeScoped(storeId);
    await scoped.order.deleteMany({ where: { storeId } });
    await scoped.cart.deleteMany({ where: { storeId } });
    await scoped.customer.deleteMany({ where: { storeId } });
    await scoped.listing.deleteMany({ where: { storeId } });
    await platformAdminTransaction(async (tx) => {
      await tx.auditLog.deleteMany({ where: { storeId } });
      await tx.store.delete({ where: { id: storeId } });
    });
    resetFakeCheckoutPayments();
  });

  it("placeOrder sends order/authorized and both timers plan and sleep on the Dev Server", async () => {
    const cart = await storeScoped(storeId).cart.create({ data: { storeId } });
    await storeScoped(storeId).cartLine.create({
      data: { storeId, cartId: cart.id, variantId, qty: 1, swapRule: "exact_only" },
    });
    const hold = computeQuote(0, [{ price: 500, qty: 1, maxPerOrder: null }], contact, "pickup").holdCents;
    const pi = await getCheckoutPayments().createPaymentIntent({
      amount: hold,
      currency: "usd",
      capture_method: "manual",
      on_behalf_of: storeAccountId,
      transfer_data: { destination: storeAccountId },
      metadata: { store_id: storeId, cart_id: cart.id },
    }, `smoke-${crypto.randomUUID()}`);
    await getCheckoutPayments().confirmPaymentIntent(pi.id, { payment_method: "pm_card_visa" });

    const placed = await placeOrder(storeId, 0, cart.id, contact, "pickup", null, null, pi.id, null);
    const runs = await waitForSleepingTimers(`order-authorized-${placed.token}`);
    const sent = await storeScoped(storeId).order.findUnique({ where: { id: placed.token } });
    expect(sent?.inngestEventSentAt).toBeTruthy();
    expect(runs.map((timer) => timer.slug).sort()).toEqual(TIMERS.map((timer) => timer.slug).sort());
    await Promise.all(runs.map((timer) => cancelRun(timer.id)));
  }, 40_000);

  it("an overlapping sweep is skipped", async () => {
    const before = new Date().toISOString();
    await Promise.all([invokeSweep(), invokeSweep()]);
    const runs = await waitForSweepRuns(before);
    expect(runs).toHaveLength(1);
  }, 20_000);
});

type DevRun = { id: string; slug: string; status: string };

/** Each timer run has planned its deadline and is sleeping on it. */
async function waitForSleepingTimers(eventId: string): Promise<DevRun[]> {
  const deadline = Date.now() + 25_000;
  let internalId = "";
  while (Date.now() < deadline) {
    internalId = internalId || (await eventInternalId(eventId));
    if (internalId) {
      const runs = (await listRuns("2026-01-01T00:00:00Z")).filter((run) => run.triggerIDs.includes(internalId));
      const sleeping = [];
      for (const timer of TIMERS) {
        const found = runs.find((run) => run.slug === timer.slug);
        if (found && (await timerSleeping(found.id, timer.name))) sleeping.push(found);
      }
      if (sleeping.length === TIMERS.length) return sleeping.map(({ id, slug, status }) => ({ id, slug, status }));
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Dev Server timers did not plan and sleep for ${eventId} (internal ${internalId || "missing"})`);
}

async function timerSleeping(runId: string, name: string): Promise<boolean> {
  const body = await gql<{ run: { trace: { childrenSpans: { name: string; status: string }[] } | null } }>(
    `query ($runID: String!) { run(runID: $runID) { trace { childrenSpans { name status } } } }`,
    { runID: runId },
  );
  const spans = body.run.trace?.childrenSpans ?? [];
  const status = (span: string) => spans.find((child) => child.name === span)?.status;
  return status(`${name}-plan-0`) === "COMPLETED" && status(`${name}-sleep-0`) === "WAITING";
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
