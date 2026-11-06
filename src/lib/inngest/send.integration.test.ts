import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const send = vi.hoisted(() => vi.fn());

vi.mock("./client", () => ({
  inngest: { send },
}));

import { storeScoped } from "../db";
import { sendOrderAuthorized } from "./send";

const hasDb = !!process.env.DATABASE_URL;

describe.skipIf(!hasDb)("sendOrderAuthorized bookkeeping (lane DB)", () => {
  let raw: PrismaClient;
  const storeIds: string[] = [];

  beforeAll(async () => {
    raw = new PrismaClient({ adapter: new PrismaPg(process.env.DATABASE_URL!) });
    await raw.$connect();
  }, 30_000);

  afterAll(async () => {
    if (raw && storeIds.length > 0) {
      await raw.$transaction([
        raw.$executeRaw`SET LOCAL ROLE app_user`,
        raw.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
        raw.orderLine.deleteMany({ where: { storeId: { in: storeIds } } }),
        raw.order.deleteMany({ where: { storeId: { in: storeIds } } }),
        raw.customer.deleteMany({ where: { storeId: { in: storeIds } } }),
      ]);
      await raw.store.deleteMany({ where: { id: { in: storeIds } } });
    }
    await raw?.$disconnect();
  }, 30_000);

  async function seedOrder() {
    const store = await raw.store.create({
      data: {
        slug: `t186-send-${crypto.randomUUID().slice(0, 8)}`,
        name: "Send store",
        themePreset: "palm-and-shea",
        stripeAccountId: `acct_send_${crypto.randomUUID().replace(/-/g, "").slice(0, 14)}`,
        stripeOnboardingStatus: "complete",
      },
    });
    storeIds.push(store.id);
    const customer = await storeScoped(store.id).customer.create({
      data: {
        storeId: store.id,
        name: "Send Buyer",
        email: "send-buyer@t186.test",
        phone: "+15551239999",
      },
    });
    const order = await storeScoped(store.id).order.create({
      data: {
        storeId: store.id,
        number: 1,
        customerId: customer.id,
        status: "AUTHORIZED",
        fulfillment: "pickup",
        subtotalCents: 500,
        tipCents: 0,
        bufferCents: 50,
        totalAuthorizedCents: 550,
        paymentIntentId: `pi_${crypto.randomUUID()}`,
      },
    });
    return { store, order };
  }

  it("a failed send logs inngest_send_failed and leaves inngestEventSentAt null", async () => {
    const { store, order } = await seedOrder();
    send.mockReset();
    send.mockRejectedValue(new Error("Inngest unreachable"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(sendOrderAuthorized(store.id, order.id)).resolves.toBeUndefined();

    const logged = errorSpy.mock.calls.flat().join(" ");
    expect(logged).toContain("inngest_send_failed");
    expect(logged).toContain(order.id);
    expect(logged).not.toContain("send-buyer@t186.test");
    expect(logged).not.toContain("inngest_sent_at_update_failed");
    const stored = await storeScoped(store.id).order.findUnique({ where: { id: order.id } });
    expect(stored?.inngestEventSentAt).toBeNull();
    errorSpy.mockRestore();
  });

  it("a failed sent-at update after a successful send logs separately", async () => {
    const { store, order } = await seedOrder();
    send.mockReset();
    send.mockImplementation(async () => {
      await storeScoped(store.id).order.delete({ where: { id: order.id } });
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(sendOrderAuthorized(store.id, order.id)).resolves.toBeUndefined();

    const logged = errorSpy.mock.calls.flat().join(" ");
    expect(logged).toContain("inngest_sent_at_update_failed");
    expect(logged).toContain(order.id);
    expect(logged).not.toContain("inngest_send_failed");
    expect(logged).not.toContain("send-buyer@t186.test");
    errorSpy.mockRestore();
  });

  it("missing and foreign-store orders do not send; the owning store still can", async () => {
    const { store, order } = await seedOrder();
    const other = await seedOrder();
    send.mockReset();
    send.mockResolvedValue({ ids: [`order-authorized-${order.id}`] });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const missingId = `ord_missing_${crypto.randomUUID()}`;

    await expect(sendOrderAuthorized(store.id, missingId)).resolves.toBeUndefined();
    await expect(sendOrderAuthorized(other.store.id, order.id)).resolves.toBeUndefined();

    expect(send).not.toHaveBeenCalled();
    expect(errorSpy.mock.calls.map((call) => call[0])).toEqual([
      JSON.stringify({ event: "inngest_order_not_found", orderId: missingId }),
      JSON.stringify({ event: "inngest_order_not_found", orderId: order.id }),
    ]);
    const hidden = await storeScoped(store.id).order.findUnique({ where: { id: order.id } });
    expect(hidden?.inngestEventSentAt).toBeNull();
    expect(hidden?.status).toBe("AUTHORIZED");

    errorSpy.mockClear();
    await expect(sendOrderAuthorized(store.id, order.id)).resolves.toBeUndefined();

    const stored = await storeScoped(store.id).order.findUnique({ where: { id: order.id } });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      id: `order-authorized-${order.id}`,
      name: "order/authorized",
      data: {
        storeId: store.id,
        orderId: order.id,
        authorizedAt: stored!.createdAt.toISOString(),
      },
    });
    expect(stored?.inngestEventSentAt).not.toBeNull();
    expect(errorSpy).not.toHaveBeenCalled();
    const foreign = await storeScoped(other.store.id).order.findUnique({ where: { id: other.order.id } });
    expect(foreign?.inngestEventSentAt).toBeNull();
    errorSpy.mockRestore();
  });
});
