import { describe, it, expect, vi, afterEach } from "vitest";
import { demoFlowsEnabled } from "./demo-gate";
import { createDemoServices } from "./demo-adapters";
import type { CheckoutInput, FlowStore } from "./contracts";
const store: FlowStore = {
  id: "a",
  slug: "a",
  name: "A",
  address: "123 Main",
  minimumOrderCents: 100,
  pickupEnabled: true,
  storeDeliveryEnabled: true,
  deliveryRadiusMi: 8,
  prepTimeMinutes: 20,
  storeDeliveryFeeCents: 399,
  autoRefundLimitCents: 500,
  insulatedPackaging: true,
  closed: false,
  opensAt: "9 am",
};
const catalog = [
  {
    listingId: "rice",
    name: "Rice",
    price: 1000,
    categoryId: "grain",
    weightG: 1000,
    frozen: false,
    maxPerOrder: 4,
    available: true,
  },
  {
    listingId: "grain",
    name: "Grain",
    price: 900,
    categoryId: "grain",
    weightG: 1000,
    frozen: false,
    maxPerOrder: 4,
    available: true,
  },
];
const input: CheckoutInput = {
  lines: [{ ...catalog[0], quantity: 1 }],
  fulfillment: "pickup",
  contact: { name: "Ada", phone: "2025550100", email: "ada@example.test" },
  notes: "",
  leaveAtDoor: false,
  slot: "asap",
  promoCode: "",
  tipCents: 0,
};
afterEach(() => vi.useRealTimers());
describe("demo flow boundary", () => {
  it("denies production deployment regardless of flag", () =>
    expect(
      demoFlowsEnabled({
        VERCEL_ENV: "production",
        NODE_ENV: "development",
        NEXT_PUBLIC_DEMO_FLOWS: "1",
      }),
    ).toBe(false));
  it("does not mistake local production for preview", () => {
    expect(demoFlowsEnabled({ NODE_ENV: "production" })).toBe(false);
    expect(demoFlowsEnabled({ VERCEL_ENV: "preview" })).toBe(true);
    expect(() => createDemoServices(store, catalog, false)).toThrow();
  });
  it("quotes a capped buffer and validates quantities and courier weight", async () => {
    const s = createDemoServices(store, catalog, true);
    const q = await s.checkout.quote(input);
    expect(q.bufferCents).toBe(Math.round(q.totalCents * 0.1));
    expect(
      (
        await s.checkout.quote({
          ...input,
          lines: [{ ...catalog[0], quantity: 5 }],
        })
      ).problems.some((p) => p.code === "max-quantity"),
    ).toBe(true);
  });
  it("scopes tokens and enforces sequential transitions and issue window", async () => {
    const s = createDemoServices(store, catalog, true);
    const q = await s.checkout.quote(input);
    const o = await s.checkout.place(input, q, await s.payment.authorize(q));
    expect(
      await createDemoServices(
        { ...store, id: "b" },
        catalog,
        true,
      ).tracking.get(o.token),
    ).toBe(null);
    await expect(s.tracking.advance(o.token, "COMPLETED")).rejects.toThrow();
    for (let i = 0; i < 5; i++) {
      const current = await s.tracking.get(o.token);
      for (const sub of current?.substitutions ?? [])
        if (!sub.decision)
          await s.substitutions.resolve(o.token, sub.id, "swap");
      await s.tracking.advance(o.token);
    }
    const result = await s.issues.submit({
      token: o.token,
      type: "missing",
      lineKeys: [JSON.stringify(["rice", null])],
      description: "Missing rice",
    });
    expect(result.needsReview).toBe(true);
    await expect(
      s.issues.submit({
        token: o.token,
        type: "missing",
        lineKeys: [JSON.stringify(["rice", null])],
        description: "Again",
      }),
    ).rejects.toThrow();
  });
  it("rejects expired authorizations and fake challenges", async () => {
    vi.useFakeTimers();
    const s = createDemoServices(store, catalog, true);
    const q = await s.checkout.quote(input);
    vi.advanceTimersByTime(16 * 60 * 1000);
    await expect(s.payment.authorize(q)).rejects.toThrow();
    const c = await s.auth.requestCode("sms", "2025550100");
    await expect(s.auth.verify(c.challengeId, "wrong")).rejects.toThrow();
    expect((await s.auth.verify(c.challengeId, "123456")).phone).toBe(
      "2025550100",
    );
  });
});
import { setSwapRule } from "./rules";
describe("substitution timeout", () => {
  it("refunds exact items after ten minutes and allows cheaper suggestions only", async () => {
    vi.useFakeTimers();
    const s = createDemoServices({ ...store, id: "timeout" }, catalog, true);
    const q = await s.checkout.quote(input);
    const o = await s.checkout.place(input, q, await s.payment.authorize(q));
    await s.tracking.advance(o.token);
    const picking = await s.tracking.advance(o.token);
    expect(picking.substitutions).toHaveLength(1);
    vi.advanceTimersByTime(600001);
    const timed = await s.tracking.get(o.token);
    expect(timed?.substitutions[0]).toMatchObject({
      decision: "refund",
      timedOut: true,
    });
    expect(timed?.finalCents).toBe(0);
  });
  it("automatically takes an equal or cheaper permitted suggestion", async () => {
    vi.useFakeTimers();
    const id = "suggest-" + crypto.randomUUID();
    setSwapRule(id, JSON.stringify(["rice", null]), { kind: "suggest" });
    const s = createDemoServices({ ...store, id }, catalog, true);
    const q = await s.checkout.quote(input);
    const o = await s.checkout.place(input, q, await s.payment.authorize(q));
    await s.tracking.advance(o.token);
    await s.tracking.advance(o.token);
    vi.advanceTimersByTime(600001);
    expect((await s.tracking.get(o.token))?.substitutions[0].decision).toBe(
      "swap",
    );
  });
  it("requires a fresh quote when checkout input changes and refuses reused authorization", async () => {
    const s = createDemoServices(
      { ...store, id: crypto.randomUUID() },
      catalog,
      true,
    );
    const q = await s.checkout.quote(input);
    const a = await s.payment.authorize(q);
    await expect(
      s.checkout.place({ ...input, tipCents: 500 }, q, a),
    ).rejects.toThrow();
    await s.checkout.place(input, q, a);
    await expect(s.checkout.place(input, q, a)).rejects.toThrow();
  });
});
describe("delivery and saved preferences", () => {
  it("caps courier service at fifteen miles and rejects unsafe frozen delivery", async () => {
    const s = createDemoServices(
      {
        ...store,
        id: crypto.randomUUID(),
        deliveryRadiusMi: 25,
        insulatedPackaging: false,
      },
      [{ ...catalog[0], frozen: true }],
      true,
    );
    const q = await s.checkout.quote({
      ...input,
      fulfillment: "courier",
      leaveAtDoor: true,
      address: {
        id: "x",
        label: "Home",
        street: "1 Main",
        city: "City",
        state: "MD",
        zip: "20910",
        distanceMi: 16,
      },
    });
    expect(q.problems.map((p) => p.code)).toContain("outside-radius");
    expect(q.problems.filter((p) => p.code === "ineligible")).toHaveLength(2);
  });
  it("freezes swap preferences when an order is placed", async () => {
    vi.useFakeTimers();
    const id = crypto.randomUUID();
    setSwapRule(id, JSON.stringify(["rice", null]), { kind: "exact" });
    const s = createDemoServices({ ...store, id }, catalog, true);
    const q = await s.checkout.quote(input);
    const o = await s.checkout.place(input, q, await s.payment.authorize(q));
    setSwapRule(id, JSON.stringify(["rice", null]), { kind: "suggest" });
    await s.tracking.advance(o.token);
    await s.tracking.advance(o.token);
    vi.advanceTimersByTime(600001);
    expect((await s.tracking.get(o.token))?.substitutions[0].decision).toBe(
      "refund",
    );
  });
});
import {
  effectiveOrderLines,
  finalOrderAmounts,
  orderIssueRefundCents,
  readDemo,
  writeDemo,
  getOrderSwapRule,
} from "./rules";
describe("settlement and identity", () => {
  async function order() {
    const s = createDemoServices(
      { ...store, id: crypto.randomUUID() },
      catalog,
      true,
    );
    const q = await s.checkout.quote({ ...input, promoCode: "WELCOME10" });
    return {
      s,
      o: await s.checkout.place(
        { ...input, promoCode: "WELCOME10" },
        q,
        await s.payment.authorize(q),
      ),
    };
  }
  it("recalculates discount and tax on actual picked goods and excludes refunded lines", async () => {
    const { o } = await order();
    o.substitutions = [
      {
        id: "s",
        lineKey: JSON.stringify(["rice", null]),
        original: o.lines[0],
        proposed: catalog[1],
        deltaCents: -100,
        expiresAt: new Date().toISOString(),
        decision: "swap",
      },
    ];
    expect(effectiveOrderLines(o)[0]).toMatchObject({
      listingId: "rice",
      name: "Grain",
      price: 900,
    });
    expect(finalOrderAmounts(o)).toMatchObject({
      subtotalCents: 900,
      discountCents: 90,
      taxCents: 49,
      totalCents: 859,
    });
    expect(orderIssueRefundCents(o, [JSON.stringify(["rice", null])])).toBe(
      859,
    );
    o.substitutions[0].decision = "refund";
    expect(effectiveOrderLines(o)).toEqual([]);
    expect(finalOrderAmounts(o).totalCents).toBe(0);
    expect(orderIssueRefundCents(o, [JSON.stringify(["rice", null])])).toBe(0);
  });
  it("never offers a swap whose tax-adjusted total exceeds the hold and honors chosen item", async () => {
    const id = crypto.randomUUID();
    const products = [
      catalog[0],
      { ...catalog[1], price: 1101 },
      { ...catalog[1], listingId: "chosen", price: 950 },
    ];
    setSwapRule(id, JSON.stringify(["rice", null]), {
      kind: "chosen",
      item: products[2],
    });
    const s = createDemoServices({ ...store, id }, products, true);
    const q = await s.checkout.quote(input);
    const o = await s.checkout.place(input, q, await s.payment.authorize(q));
    await s.tracking.advance(o.token);
    const picked = await s.tracking.advance(o.token);
    expect(picked.substitutions[0].proposed.listingId).toBe("chosen");
    const other = createDemoServices(
      { ...store, id: crypto.randomUUID() },
      products.slice(0, 2),
      true,
    );
    const q2 = await other.checkout.quote(input);
    const o2 = await other.checkout.place(
      input,
      q2,
      await other.payment.authorize(q2),
    );
    await other.tracking.advance(o2.token);
    expect((await other.tracking.advance(o2.token)).substitutions).toHaveLength(
      0,
    );
  });
  it("restores saved addresses after sign out and sign in across stores", async () => {
    const { s } = await order();
    const dest = crypto.randomUUID() + "@example.test";
    let c = await s.auth.requestCode("email", dest);
    const p = await s.auth.verify(c.challengeId, "123456");
    await s.auth.saveProfile({
      ...p,
      name: "Ada",
      addresses: [
        {
          id: "home",
          label: "Home",
          street: "1 Main",
          city: "City",
          state: "MD",
          zip: "20910",
          distanceMi: 2,
        },
      ],
    });
    await s.auth.signOut();
    expect(await s.auth.profile()).toBeNull();
    const other = createDemoServices(
      { ...store, id: crypto.randomUUID() },
      catalog,
      true,
    );
    c = await other.auth.requestCode("email", dest.toUpperCase());
    expect(
      (await other.auth.verify(c.challengeId, "123456")).addresses[0].id,
    ).toBe("home");
  });
  it("cancels only before picking and releases the hold", async () => {
    const { s, o } = await order();
    expect(await s.tracking.advance(o.token, "CANCELLED")).toMatchObject({
      status: "CANCELLED",
      finalCents: 0,
    });
    await expect(s.tracking.advance(o.token)).rejects.toThrow();
  });
  it("returns safe empty data for corrupt nested records and rules", async () => {
    const id = crypto.randomUUID();
    writeDemo(`demo-orders:v1:${id}`, [
      {
        storeId: id,
        token: "x",
        lines: [],
        events: [null],
        substitutions: [],
        quote: { totalCents: 0 },
        createdAt: "today",
      },
    ]);
    writeDemo("demo-profile:v1", {
      id: "x",
      name: "x",
      phone: "",
      email: "",
      addresses: [null],
    });
    writeDemo(`demo-order-rules:${id}:o`, null);
    const s = createDemoServices({ ...store, id }, catalog, true);
    expect(await s.tracking.list()).toEqual([]);
    expect(await s.auth.profile()).toBeNull();
    expect(getOrderSwapRule(id, "o", "line")).toEqual({ kind: "exact" });
  });
  it("uses memory when localStorage throws", () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        get localStorage() {
          throw Error("blocked");
        },
      },
    });
    try {
      writeDemo("blocked-test", { ok: true });
      expect(readDemo("blocked-test", null)).toEqual({ ok: true });
    } finally {
      if (original) Object.defineProperty(globalThis, "window", original);
      else Reflect.deleteProperty(globalThis, "window");
    }
  });
});
it("prevents an issue refund for a line already refunded during picking", async () => {
  vi.useFakeTimers();
  const s = createDemoServices(
    { ...store, id: crypto.randomUUID() },
    catalog,
    true,
  );
  const q = await s.checkout.quote(input);
  const o = await s.checkout.place(input, q, await s.payment.authorize(q));
  await s.tracking.advance(o.token);
  await s.tracking.advance(o.token);
  vi.advanceTimersByTime(600001);
  await s.tracking.get(o.token);
  await s.tracking.advance(o.token);
  await s.tracking.advance(o.token);
  await s.tracking.advance(o.token);
  await expect(
    s.issues.submit({
      token: o.token,
      type: "missing",
      lineKeys: [JSON.stringify(["rice", null])],
      description: "Refund again",
    }),
  ).rejects.toThrow("Select affected items");
});
describe("replacement delivery safety", () => {
  async function pending(
    id: string,
    products = catalog,
    fulfillment: "pickup" | "courier" = "pickup",
    leaveAtDoor = false,
  ) {
    const s = createDemoServices(
      { ...store, id, insulatedPackaging: false },
      products,
      true,
    );
    const q = await s.checkout.quote({
      ...input,
      fulfillment,
      leaveAtDoor,
      address: {
        id: "x",
        label: "Home",
        street: "1 Main",
        city: "City",
        state: "MD",
        zip: "20910",
        distanceMi: 2,
      },
    });
    const o = await s.checkout.place(
      {
        ...input,
        fulfillment,
        leaveAtDoor,
        address: {
          id: "x",
          label: "Home",
          street: "1 Main",
          city: "City",
          state: "MD",
          zip: "20910",
          distanceMi: 2,
        },
      },
      q,
      await s.payment.authorize(q),
    );
    await s.tracking.advance(o.token);
    return { s, o, p: await s.tracking.advance(o.token) };
  }
  it("treats null order rules and chosen-without-item as exact at timeout", async () => {
    vi.useFakeTimers();
    for (const rules of [
      null,
      { [JSON.stringify(["rice", null])]: { kind: "chosen" } },
    ]) {
      const id = crypto.randomUUID();
      const { s, o } = await pending(id);
      writeDemo(`demo-order-rules:${id}:${o.id}`, rules);
      vi.advanceTimersByTime(600001);
      expect((await s.tracking.get(o.token))?.substitutions[0].decision).toBe(
        "refund",
      );
    }
  });
  it("does not offer heavy courier or frozen uninsulated and leave-at-door replacements", async () => {
    for (const [weight, frozen, mode, leave] of [
      [30000, false, "courier", false],
      [1000, true, "courier", false],
      [1000, true, "pickup", true],
    ] as const) {
      const products = [catalog[0], { ...catalog[1], weightG: weight, frozen }];
      expect(
        (await pending(crypto.randomUUID(), products, mode, leave)).p
          .substitutions,
      ).toHaveLength(0);
    }
  });
  it("rechecks eligibility at consent and automatically refunds an unsafe timed-out proposal", async () => {
    vi.useFakeTimers();
    const id = crypto.randomUUID(),
      products = catalog.map((c) => ({ ...c }));
    setSwapRule(id, JSON.stringify(["rice", null]), { kind: "suggest" });
    const { s, o, p } = await pending(id, products, "courier");
    products[1].weightG = 30000;
    await expect(
      s.substitutions.resolve(o.token, p.substitutions[0].id, "swap"),
    ).rejects.toThrow("ineligible");
    vi.advanceTimersByTime(600001);
    expect((await s.tracking.get(o.token))?.substitutions[0].decision).toBe(
      "refund",
    );
  });
});
