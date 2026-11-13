import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { testPrismaClient } from "@/lib/test-prisma";
import { storeScoped } from "../db";
import { makeFakeStep } from "../inngest/fake-step";
import {
  COURIER_BOTH_FAILED,
  COURIER_DELIVERY_CREATED,
  COURIER_FAILOVER_TRIGGERED,
  runCourierFailover,
  selectAndDispatch,
  type CourierEvent,
} from "./dispatch";
import {
  DeliveryProviderError,
  type CreatedDelivery,
  type DeliveryProvider,
  type DeliveryProviderName,
  type DeliveryQuote,
  type DeliveryRequest,
  type DeliveryWebhookEvent,
} from "./provider";

const hasDb = !!process.env.DATABASE_URL;

/**
 * Stub courier with the providers' own rules: create needs a live quote it issued, for the same delivery id;
 * a delivery is created once and cancelled once.
 */
class StubProvider implements DeliveryProvider {
  readonly quotes = new Map<string, { externalDeliveryId: string; expiresAt: Date }>();
  readonly created = new Map<string, "active" | "cancelled">();
  quoteCalls = 0;
  failCreate = false;
  failQuote = false;
  expiresInMs = 5 * 60_000;

  constructor(
    readonly name: DeliveryProviderName,
    private readonly feeCents: number,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async quote(req: DeliveryRequest): Promise<DeliveryQuote> {
    this.quoteCalls++;
    if (this.failQuote) throw new DeliveryProviderError(this.name, 503, "service_unavailable", "down");
    const quoteId = `${this.name}-q${this.quoteCalls}`;
    const expiresAt = new Date(this.now().getTime() + this.expiresInMs);
    this.quotes.set(quoteId, { externalDeliveryId: req.externalDeliveryId, expiresAt });
    return { quoteId, feeCents: this.feeCents, currency: "USD", pickupEta: null, dropoffEta: null, expiresAt };
  }

  async create(quoteId: string, req: DeliveryRequest): Promise<CreatedDelivery> {
    const quote = this.quotes.get(quoteId);
    if (!quote || quote.externalDeliveryId !== req.externalDeliveryId) throw new DeliveryProviderError(this.name, 404, "quote_not_found", "unknown quote");
    if (quote.expiresAt <= this.now()) throw new DeliveryProviderError(this.name, 400, "quote_expired", "quote expired");
    if (this.failCreate) throw new DeliveryProviderError(this.name, 422, "validation_error", "rejected");
    const externalId = `${this.name}-${req.externalDeliveryId}`;
    if (this.created.has(externalId)) throw new DeliveryProviderError(this.name, 409, "duplicate_delivery_id", "exists");
    this.created.set(externalId, "active");
    return { externalId, trackingUrl: `https://track.example/${externalId}` };
  }

  async cancel(externalId: string): Promise<void> {
    const state = this.created.get(externalId);
    if (!state) throw new DeliveryProviderError(this.name, 404, "not_found", "unknown delivery");
    if (state === "cancelled") throw new DeliveryProviderError(this.name, 409, "cannot_be_cancelled", "already cancelled");
    this.created.set(externalId, "cancelled");
  }

  handleWebhook(): DeliveryWebhookEvent {
    throw new Error("not used");
  }
}

const request = {
  pickup: {
    businessName: "Dispatch Test Market",
    address: { line1: "8121 Georgia Ave", city: "Silver Spring", state: "MD", zip: "20910" },
    phone: "+13015550100",
  },
  dropoff: { address: { line1: "1100 Wayne Ave", city: "Silver Spring", state: "MD", zip: "20910" }, phone: "+13015550199" },
  orderValueCents: 6000,
  tipCents: 0,
};

describe.skipIf(!hasDb)("courier selection and failover", () => {
  let raw: PrismaClient;
  const storeIds: string[] = [];
  let events: CourierEvent[];
  const emit = async (event: CourierEvent) => {
    events.push(event);
  };

  async function courierOrder(flags: { pickupEnabled: boolean; storeDeliveryEnabled: boolean }) {
    raw ??= testPrismaClient();
    const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const store = await raw.store.create({
      data: { slug: `dispatch-${stamp}`, name: "Dispatch Test Market", themePreset: "palm-and-shea", ...flags },
    });
    storeIds.push(store.id);
    const customer = await storeScoped(store.id).customer.create({
      data: { storeId: store.id, name: "Dispatch Buyer", email: `dispatch-${stamp}@example.com` },
    });
    const order = await storeScoped(store.id).order.create({
      data: {
        storeId: store.id,
        customerId: customer.id,
        status: "READY",
        fulfillment: "courier",
        subtotalCents: 6000,
        bufferCents: 0,
        totalCents: 6000,
        totalAuthorizedCents: 6000,
        number: 7,
      },
    });
    return { storeId: store.id, orderId: order.id };
  }

  beforeEach(() => {
    events = [];
  });

  afterAll(async () => {
    for (const id of storeIds) {
      const scoped = storeScoped(id);
      await scoped.deliveryEvent.deleteMany({});
      await scoped.delivery.deleteMany({});
      await scoped.order.deleteMany({});
      await scoped.customer.deleteMany({});
    }
    if (raw) {
      await raw.store.deleteMany({ where: { id: { in: storeIds } } });
      await raw.$disconnect();
    }
  });

  it("AC1/AC2: quotes both, books the cheaper and records its provider, brand and quoted fee", async () => {
    const { storeId, orderId } = await courierOrder({ pickupEnabled: true, storeDeliveryEnabled: false });
    const doordash = new StubProvider("doordash", 899);
    const uber = new StubProvider("uber", 749);

    const result = await selectAndDispatch({ storeId, orderId, request }, { providers: [doordash, uber], emit });

    expect(result).toMatchObject({ ok: true, courierProvider: "Uber Direct" });
    expect(doordash.quoteCalls).toBe(1);
    expect(doordash.created.size).toBe(0);
    const rows = await storeScoped(storeId).delivery.findMany({ where: { orderId } });
    expect(rows).toMatchObject([{ provider: "uber", quoteFeeCents: 749, status: "requested" }]);
    expect(events).toEqual([{ name: COURIER_DELIVERY_CREATED, data: { storeId, deliveryId: rows[0].id } }]);
  });
});
