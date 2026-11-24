import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { testPrismaClient } from "@/lib/test-prisma";
import { storeScoped, storeScopedTransaction } from "../db";
import { makeFakeStep } from "../inngest/fake-step";
import { newOrderPush } from "../inngest/functions";
import { clearTestSentEmails, getTestSentEmails, setEmailSenderForTests } from "./send";
import { newOrderEmailOn, sendNewOrderOwnerEmail, setNewOrderEmail } from "./new-order-owner";
import { setNewOrderEmailAction } from "./new-order-owner-actions";

const session = vi.hoisted(() => ({ storeId: "", userId: "", role: "owner" }));
vi.mock("@/lib/store-admin/session", () => ({
  requireStoreMember: vi.fn(async () => ({ store: { id: session.storeId }, user: { id: session.userId }, membership: { role: session.role, readOnly: false } })),
}));

const hasDb = !!process.env.DATABASE_URL;
const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

type Handler = (ctx: { event: { data: Record<string, unknown> }; step: ReturnType<typeof makeFakeStep> }) => Promise<unknown>;
const handler = (newOrderPush as unknown as { fn: Handler }).fn;

describe.skipIf(!hasDb)("new-order email to the owner (#785)", () => {
  let raw: PrismaClient;
  let store: string;
  let otherStore: string;
  const slug = `owner-mail-${suffix}`;
  const owner = `owner-mail-o-${suffix}`;
  const coOwner = `owner-mail-co-${suffix}`;
  const staff = `owner-mail-s-${suffix}`;
  const otherOwner = `owner-mail-x-${suffix}`;
  const email = (id: string) => `${id}@example.com`;
  let customer: string;
  let number = 7000;

  async function createOrder() {
    return storeScopedTransaction(store, (tx) =>
      tx.order.create({
        data: {
          storeId: store, number: ++number, customerId: customer, status: "AUTHORIZED", fulfillment: "pickup",
          subtotalCents: 2450, bufferCents: 200, totalAuthorizedCents: 2650, totalCents: 2450,
        },
      }),
    );
  }

  const sentTo = (to: string) => getTestSentEmails().filter((message) => message.to === to);

  beforeAll(async () => {
    raw = testPrismaClient();
    store = (await raw.store.create({ data: { slug, name: "Mama's Market", themePreset: "palm-and-shea" } })).id;
    otherStore = (await raw.store.create({ data: { slug: `${slug}-x`, name: "Other", themePreset: "palm-and-shea" } })).id;
    await raw.user.createMany({ data: [owner, coOwner, staff, otherOwner].map((id) => ({ id, name: id, email: email(id) })) });
    await storeScoped(store).storeMembership.createMany({
      data: [
        { storeId: store, userId: owner, role: "owner" },
        { storeId: store, userId: coOwner, role: "owner" },
        { storeId: store, userId: staff, role: "staff" },
      ],
    });
    await storeScoped(otherStore).storeMembership.create({ data: { storeId: otherStore, userId: otherOwner, role: "owner" } });
    customer = (await storeScoped(store).customer.create({ data: { storeId: store, name: "Ada Obi" } })).id;
  });

  beforeEach(() => clearTestSentEmails());

  afterEach(async () => {
    setEmailSenderForTests(null);
    vi.restoreAllMocks();
    await storeScoped(store).storeMembership.updateMany({ data: { newOrderEmail: true } });
  });

  afterAll(async () => {
    for (const id of [store, otherStore]) {
      await storeScoped(id).order.deleteMany({});
      await storeScoped(id).customer.deleteMany({});
      await storeScoped(id).storeMembership.deleteMany({});
    }
    await raw.user.deleteMany({ where: { id: { in: [owner, coOwner, staff, otherOwner] } } });
    await raw.store.deleteMany({ where: { id: { in: [store, otherStore] } } });
    await raw.$disconnect();
  });

  it("emails each owner by default with the order and a link that opens it to accept, and no one else", async () => {
    const order = await createOrder();
    await handler({ event: { data: { storeId: store, orderId: order.id } }, step: makeFakeStep() });

    for (const to of [owner, coOwner]) {
      const [message] = sentTo(email(to));
      expect(message.subject).toContain(`#${order.number}`);
      expect(message.html).toContain("$24.50");
      expect(message.html).toContain(`/store-admin/orders?store=${slug}&amp;order=${order.id}`);
      expect(message.idempotencyKey).toBeTruthy();
    }
    expect(sentTo(email(staff))).toEqual([]);
    expect(sentTo(email(otherOwner))).toEqual([]);
  });

  it("on the production alias the link opens the alias, not the deployment's own URL (#796)", async () => {
    const order = await createOrder();
    const alias = "african-market-ai-ecommerce.vercel.app";
    await sendNewOrderOwnerEmail(store, order.id, {
      VERCEL: "1",
      VERCEL_ENV: "production",
      VERCEL_URL: "african-market-ai-ecommerce-h3x9.vercel.app",
      VERCEL_PROJECT_PRODUCTION_URL: alias,
    });
    const [message] = sentTo(email(owner));
    expect(message.html).toContain(`https://${alias}/store-admin/orders?store=${slug}&amp;order=${order.id}`);
  });

  it("an owner who turned it off gets no email; the other owner still does", async () => {
    expect(await newOrderEmailOn(store, owner)).toBe(true);
    await setNewOrderEmail(store, owner, false);
    expect(await newOrderEmailOn(store, owner)).toBe(false);

    const order = await createOrder();
    await handler({ event: { data: { storeId: store, orderId: order.id } }, step: makeFakeStep() });

    expect(sentTo(email(owner))).toEqual([]);
    expect(sentTo(email(coOwner))).toHaveLength(1);
  });

  it("a failed send never throws, is logged without the address, and the other owner still gets theirs", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const sent: string[] = [];
    setEmailSenderForTests({
      async send(message) {
        if (message.to === email(owner)) throw new Error("Resend 403");
        sent.push(message.to);
        return { id: "ok" };
      },
    });
    const order = await createOrder();
    await expect(handler({ event: { data: { storeId: store, orderId: order.id } }, step: makeFakeStep() })).resolves.not.toThrow();

    expect(sent).toEqual([email(coOwner)]);
    const logged = errors.mock.calls.flat().join(" ");
    expect(logged).toContain("new_order_email_failed");
    expect(logged).not.toContain(email(owner));
  });

  it("the toggle changes only the signed-in owner's own setting; staff cannot turn it on", async () => {
    Object.assign(session, { storeId: store, userId: coOwner, role: "owner" });
    expect(await setNewOrderEmailAction(false)).toEqual({ ok: true });
    expect(await newOrderEmailOn(store, coOwner)).toBe(false);
    expect(await newOrderEmailOn(store, owner)).toBe(true);
    expect((await setNewOrderEmailAction("off")).ok).toBe(false);

    Object.assign(session, { userId: staff, role: "staff" });
    await storeScoped(store).storeMembership.updateMany({ where: { userId: staff }, data: { newOrderEmail: false } });
    expect((await setNewOrderEmailAction(true)).ok).toBe(false);
    expect(await newOrderEmailOn(store, staff)).toBe(false);
  });
});
