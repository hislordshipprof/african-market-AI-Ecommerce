import { cartItemKey } from "../storefront/cart-store";
import { serviceFeeCents } from "../order/platform-fee";
import type {
  CheckoutInput,
  CheckoutQuote,
  CustomerProfile,
  FlowCatalogItem,
  FlowOrder,
  FlowServices,
  FlowStore,
  IssueResult,
  OrderStatus,
} from "./contracts";
import {
  effectiveOrderLines,
  DEMO_SERVICE_FEE,
  finalOrderAmounts,
  getOrderSwapRule,
  orderIssueRefundCents,
  getSwapRule,
  readDemo,
  writeDemo,
} from "./rules";
const uuid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const clone = <T>(v: T): T => structuredClone(v);
const fail = (message: string): never => {
  throw new Error(message);
};
const challenges = new Map<
  string,
  {
    channel: string;
    destination: string;
    expires: number;
  }
>();
export function createDemoServices(
  store: FlowStore,
  catalog: FlowCatalogItem[],
  enabled: boolean,
): FlowServices {
  if (!enabled) fail("Demo flows are disabled.");
  const key = `demo-orders:v1:${store.id}`;
  const quotes = new Map<
    string,
    {
      quote: CheckoutQuote;
      input: string;
    }
  >();
  const authorizations = new Map<
    string,
    {
      quoteId: string;
      amount: number;
    }
  >();
  const read = (): FlowOrder[] => {
    const data = readDemo<unknown>(key, []);
    return Array.isArray(data)
      ? data.filter(
          (o): o is FlowOrder =>
            !!o &&
            o.storeId === store.id &&
            typeof o.token === "string" &&
            Array.isArray(o.lines) &&
            o.lines.every(
              (l: Record<string, unknown>) =>
                l &&
                typeof l.listingId === "string" &&
                typeof l.name === "string" &&
                Number.isSafeInteger(l.price) &&
                Number.isSafeInteger(l.quantity) &&
                Number(l.quantity) > 0,
            ) &&
            Array.isArray(o.events) &&
            o.events.every(
              (e: Record<string, unknown>) =>
                e && typeof e.status === "string" && typeof e.at === "string",
            ) &&
            Array.isArray(o.substitutions) &&
            o.substitutions.every(
              (s: Record<string, unknown>) =>
                s &&
                typeof s.id === "string" &&
                typeof s.lineKey === "string" &&
                typeof s.expiresAt === "string" &&
                s.original &&
                s.proposed &&
                typeof s.deltaCents === "number" &&
                typeof (s.original as Record<string, unknown>).listingId ===
                  "string" &&
                Number.isSafeInteger(
                  (s.original as Record<string, unknown>).price,
                ) &&
                Number.isSafeInteger(
                  (s.original as Record<string, unknown>).quantity,
                ) &&
                typeof (s.proposed as Record<string, unknown>).listingId ===
                  "string" &&
                typeof (s.proposed as Record<string, unknown>).name ===
                  "string" &&
                Number.isSafeInteger(
                  (s.proposed as Record<string, unknown>).price,
                ),
            ) &&
            !!o.quote &&
            [
              "subtotalCents",
              "deliveryFeeCents",
              "courierFeeCents",
              "taxCents",
              "tipCents",
              "discountCents",
              "totalCents",
              "bufferCents",
              "holdCents",
            ].every(
              (k) => Number.isSafeInteger(o.quote[k]) && o.quote[k] >= 0,
            ) &&
            typeof o.createdAt === "string",
        )
      : [];
  };
  const save = (o: FlowOrder) => {
    writeDemo(key, [...read().filter((x) => x.token !== o.token), o]);
    return clone(o);
  };
  const finish = (o: FlowOrder) => {
    const total = finalOrderAmounts(o).totalCents;
    if (total > o.quote.holdCents) fail("Final amount exceeds payment hold.");
    o.finalCents = total;
  };
  const eligibleBasket = (o: FlowOrder): boolean => {
    let weight = 0,
      frozen = false;
    for (const line of o.lines) {
      const sub = o.substitutions.find((s) => s.lineKey === cartItemKey(line));
      if (sub?.decision === "refund") continue;
      const item = catalog.find(
        (c) =>
          cartItemKey(c) ===
          cartItemKey(sub?.decision === "swap" ? sub.proposed : line),
      );
      if (!item || !item.available || line.quantity > item.maxPerOrder)
        return false;
      frozen ||= item.frozen;
      weight += item.weightG * line.quantity;
      if (o.fulfillment === "courier" && item.weightG > 22679.6) return false;
    }
    return (
      !(frozen && o.leaveAtDoor) &&
      !(
        o.fulfillment === "courier" &&
        (weight > 22679.6 || (frozen && !store.insulatedPackaging))
      )
    );
  };
  const settle = (o: FlowOrder) => {
    let changed = false;
    for (const sub of o.substitutions) {
      if (!sub.decision && Date.parse(sub.expiresAt) <= Date.now()) {
        const rule = getOrderSwapRule(store.id, o.id, sub.lineKey);
        const candidate = {
          ...o,
          substitutions: o.substitutions.map((s) =>
            s.id === sub.id ? { ...s, decision: "swap" as const } : s,
          ),
        };
        sub.decision =
          sub.deltaCents <= 0 &&
          eligibleBasket(candidate) &&
          finalOrderAmounts(candidate).totalCents <= o.quote.holdCents &&
          (rule.kind === "suggest" ||
            (rule.kind === "chosen" &&
              cartItemKey(rule.item) === cartItemKey(sub.proposed)))
            ? "swap"
            : "refund";
        sub.timedOut = true;
        changed = true;
      }
    }
    if (changed) {
      finish(o);
      save(o);
    }
    return o;
  };
  const get = (token: string) => {
    const o = read().find((x) => x.token === token);
    return o ? settle(o) : null;
  };
  const must = (token: string) =>
    get(token) ?? fail("Order not found in this store and browser.");
  const quote = async (input: CheckoutInput): Promise<CheckoutQuote> => {
    const problems: CheckoutQuote["problems"] = [];
    let subtotal = 0,
      weight = 0,
      frozen = false;
    const seen = new Set<string>();
    for (const line of input.lines) {
      const lk = cartItemKey(line),
        item = catalog.find((x) => cartItemKey(x) === lk);
      if (!item || !item.available) {
        problems.push({
          code: "out-of-stock",
          message: "An item is unavailable.",
          lineKey: lk,
        });
        continue;
      }
      if (
        seen.has(lk) ||
        !Number.isInteger(line.quantity) ||
        line.quantity < 1 ||
        line.quantity > item.maxPerOrder
      )
        problems.push({
          code: "max-quantity",
          message: "Check item quantity.",
          lineKey: lk,
        });
      seen.add(lk);
      subtotal += item.price * line.quantity;
      weight += item.weightG * line.quantity;
      frozen ||= item.frozen;
      if (input.fulfillment === "courier" && item.weightG > 22679.6)
        problems.push({
          code: "ineligible",
          message: "This item exceeds the courier weight limit.",
        });
    }
    if (!input.lines.length || subtotal < store.minimumOrderCents)
      problems.push({
        code: "minimum-order",
        message: `Minimum order is $${(store.minimumOrderCents / 100).toFixed(2)}.`,
      });
    if (
      !input.contact.name.trim() ||
      !/^\+?[\d\s().-]{10,20}$/.test(input.contact.phone) ||
      input.contact.phone.replace(/\D/g, "").length < 10
    )
      problems.push({
        code: "invalid-contact",
        message: "Enter your name and a valid phone number.",
      });
    if (
      (input.fulfillment === "pickup" && !store.pickupEnabled) ||
      (input.fulfillment === "store-delivery" && !store.storeDeliveryEnabled)
    )
      problems.push({
        code: "ineligible",
        message: "This fulfillment option is unavailable.",
      });
    if (
      input.fulfillment !== "pickup" &&
      (!input.address ||
        !Number.isFinite(input.address.distanceMi) ||
        input.address.distanceMi < 0 ||
        input.address.distanceMi >
          (input.fulfillment === "courier"
            ? Math.min(15, store.deliveryRadiusMi)
            : store.deliveryRadiusMi))
    )
      problems.push({
        code: "outside-radius",
        message: "Choose an address within the delivery radius.",
      });
    if (
      input.fulfillment === "courier" &&
      (weight > 22679.6 || (frozen && !store.insulatedPackaging))
    )
      problems.push({
        code: "ineligible",
        message:
          "Courier requires an order under 50 lb and insulated packaging for frozen items.",
      });
    if (frozen && input.leaveAtDoor)
      problems.push({
        code: "ineligible",
        message: "Frozen items require handoff.",
      });
    if (
      input.slot !== "asap" &&
      (!Number.isFinite(Date.parse(input.slot)) ||
        Date.parse(input.slot) < Date.now() ||
        Date.parse(input.slot) > Date.now() + 6 * 86400000)
    )
      problems.push({
        code: "ineligible",
        message: "Choose a slot within the next six days.",
      });
    if (!Number.isSafeInteger(input.tipCents) || input.tipCents < 0)
      problems.push({
        code: "ineligible",
        message: "Tip must be a positive amount.",
      });
    const discount =
      input.promoCode.trim().toUpperCase() === "WELCOME10"
        ? Math.min(1000, Math.round(subtotal * 0.1))
        : 0;
    const delivery =
        input.fulfillment === "store-delivery"
          ? store.storeDeliveryFeeCents
          : 0,
      courier = input.fulfillment === "courier" ? 699 : 0,
      tax = Math.round((subtotal - discount) * 0.06),
      tip = Math.max(
        0,
        Number.isSafeInteger(input.tipCents) ? input.tipCents : 0,
      ),
      serviceFee = serviceFeeCents(subtotal - discount, DEMO_SERVICE_FEE),
      total = subtotal - discount + serviceFee + delivery + courier + tax + tip,
      buffer = Math.min(2000, Math.round(total * 0.1));
    const q: CheckoutQuote = {
      id: uuid(),
      subtotalCents: subtotal,
      deliveryFeeCents: delivery,
      courierFeeCents: courier,
      courierProvider:
        input.fulfillment === "courier" ? "Uber Direct" : undefined,
      serviceFeeCents: serviceFee,
      taxCents: tax,
      tipCents: tip,
      discountCents: discount,
      totalCents: total,
      bufferCents: buffer,
      holdCents: total + buffer,
      expiresAt: new Date(Date.now() + 15 * 60000).toISOString(),
      problems,
    };
    quotes.set(q.id, { quote: clone(q), input: JSON.stringify(input) });
    return q;
  };
  const validProfile = (p: CustomerProfile | null): p is CustomerProfile =>
    !!p &&
    typeof p.id === "string" &&
    typeof p.name === "string" &&
    typeof p.phone === "string" &&
    typeof p.email === "string" &&
    Array.isArray(p.addresses) &&
    p.addresses.every(
      (a) =>
        a &&
        typeof a.id === "string" &&
        typeof a.street === "string" &&
        typeof a.city === "string" &&
        typeof a.state === "string" &&
        typeof a.zip === "string" &&
        typeof a.label === "string" &&
        Number.isFinite(a.distanceMi),
    );
  const normalize = (destination: string) =>
    destination.includes("@")
      ? destination.trim().toLowerCase()
      : destination.replace(/\D/g, "");
  const persistProfile = (p: CustomerProfile) => {
    writeDemo("demo-profile:v1", p);
    for (const destination of [p.phone, p.email].filter(Boolean))
      writeDemo("demo-profile-identity:v1:" + normalize(destination), p);
  };
  return {
    checkout: {
      quote,
      async place(input, q, a) {
        const saved = quotes.get(q.id),
          auth = authorizations.get(a.id);
        if (
          !saved ||
          saved.input !== JSON.stringify(input) ||
          JSON.stringify(saved.quote) !== JSON.stringify(q) ||
          Date.parse(q.expiresAt) <= Date.now() ||
          !auth ||
          auth.quoteId !== q.id ||
          auth.amount !== q.holdCents ||
          a.amountCents !== q.holdCents
        )
          fail("Checkout session expired. Please quote again.");
        const fresh = await quote(input);
        if (fresh.problems.length) fail(fresh.problems[0].message);
        authorizations.delete(a.id);
        quotes.delete(q.id);
        const id = uuid();
        writeDemo(
          `demo-order-rules:${store.id}:${id}`,
          Object.fromEntries(
            input.lines.map((l) => [
              cartItemKey(l),
              getSwapRule(store.id, cartItemKey(l)),
            ]),
          ),
        );
        return save({
          id,
          token: uuid(),
          number: `DEMO-${id.slice(0, 8).toUpperCase()}`,
          storeId: store.id,
          storeName: store.name,
          createdAt: now(),
          status: "AUTHORIZED",
          lines: input.lines.map((l) => ({
            ...catalog.find((c) => cartItemKey(c) === cartItemKey(l))!,
            quantity: l.quantity,
          })),
          fulfillment: input.fulfillment,
          contact: clone(input.contact),
          address: input.address,
          pickupAddress: store.address,
          notes: input.notes,
          leaveAtDoor: input.leaveAtDoor,
          slot: input.slot,
          quote: clone(q),
          etaLabel: `About ${store.prepTimeMinutes} minutes`,
          events: [{ status: "AUTHORIZED", at: now() }],
          substitutions: [],
        });
      },
    },
    payment: {
      async authorize(q, outcome = "success") {
        if (outcome === "declined") fail("Test payment declined.");
        if (
          !quotes.has(q.id) ||
          q.problems.length ||
          Date.parse(q.expiresAt) <= Date.now()
        )
          fail("Quote expired or ineligible.");
        const id = uuid();
        authorizations.set(id, { quoteId: q.id, amount: q.holdCents });
        return { id, amountCents: q.holdCents };
      },
    },
    addresses: {
      async search(query) {
        return query.trim().length < 3
          ? []
          : [
              {
                id: uuid(),
                label: "Demo address",
                street: query.trim(),
                city: "Demo City",
                state: "MD",
                zip: "20910",
                distanceMi: 3.2,
              },
            ];
      },
    },
    tracking: {
      async get(token) {
        return clone(get(token));
      },
      async list() {
        return read().map((o) => clone(settle(o)));
      },
      async advance(token, status) {
        const o = must(token);
        if (status === "CANCELLED") {
          if (!["AUTHORIZED", "ACCEPTED"].includes(o.status))
            fail("Cancellation is no longer available.");
          o.status = "CANCELLED";
          o.finalCents = 0;
          o.events.push({
            status: "CANCELLED",
            at: now(),
            note: "Test hold released; no charge.",
          });
          return save(o);
        }
        const path: OrderStatus[] =
          o.fulfillment === "pickup"
            ? [
                "AUTHORIZED",
                "ACCEPTED",
                "PICKING",
                "READY",
                "AWAITING_PICKUP",
                "COMPLETED",
              ]
            : [
                "AUTHORIZED",
                "ACCEPTED",
                "PICKING",
                "READY",
                "COURIER_ASSIGNED",
                "PICKED_UP",
                "DELIVERED",
                "COMPLETED",
              ];
        if (o.substitutions.some((s) => !s.decision))
          fail("Resolve the substitution first.");
        if (path.indexOf(o.status) < 0) fail("Order is terminal.");
        const next = path[path.indexOf(o.status) + 1];
        if (!next || (status && status !== next))
          fail("Invalid order transition.");
        o.status = next;
        o.events.push({ status: next, at: now() });
        if (next === "PICKING" && o.substitutions.length === 0) {
          const line = o.lines[0];
          const rule = getOrderSwapRule(store.id, o.id, cartItemKey(line));
          const proposed = catalog.find(
            (c) =>
              c.available &&
              eligibleBasket({
                ...o,
                substitutions: [
                  ...o.substitutions,
                  {
                    id: "candidate",
                    lineKey: cartItemKey(line),
                    original: line,
                    proposed: c,
                    deltaCents: 0,
                    expiresAt: now(),
                    decision: "swap",
                  },
                ],
              }) &&
              c.maxPerOrder >= line.quantity &&
              (rule.kind !== "chosen" ||
                cartItemKey(c) === cartItemKey(rule.item)) &&
              c.categoryId ===
                catalog.find((x) => cartItemKey(x) === cartItemKey(line))
                  ?.categoryId &&
              cartItemKey(c) !== cartItemKey(line) &&
              finalOrderAmounts({
                ...o,
                substitutions: [
                  ...o.substitutions,
                  {
                    id: "candidate",
                    lineKey: cartItemKey(line),
                    original: line,
                    proposed: c,
                    deltaCents: 0,
                    expiresAt: now(),
                    decision: "swap",
                  },
                ],
              }).totalCents <= o.quote.holdCents,
          );
          if (proposed)
            o.substitutions.push({
              id: uuid(),
              lineKey: cartItemKey(line),
              original: clone(line),
              proposed: clone(proposed),
              deltaCents: (proposed.price - line.price) * line.quantity,
              expiresAt: new Date(Date.now() + 600000).toISOString(),
            });
        }
        if (next === "READY") finish(o);
        if (next === "COMPLETED") {
          o.completedAt = now();
          finish(o);
        }
        if (next === "COURIER_ASSIGNED")
          o.courier = {
            provider:
              o.fulfillment === "courier" ? "Uber Direct" : "Store driver",
            name: "Demo driver",
            etaLabel: "15 minutes",
          };
        return save(o);
      },
    },
    substitutions: {
      async resolve(token, id, decision) {
        const o = must(token),
          sub = o.substitutions.find((s) => s.id === id);
        if (!sub || sub.decision)
          return fail("Substitution is no longer pending.");
        if (
          decision === "swap" &&
          finalOrderAmounts({
            ...o,
            substitutions: o.substitutions.map((s) =>
              s.id === id ? { ...s, decision: "swap" } : s,
            ),
          }).totalCents > o.quote.holdCents
        )
          fail("Swap exceeds payment hold.");
        if (
          decision === "swap" &&
          !eligibleBasket({
            ...o,
            substitutions: o.substitutions.map((s) =>
              s.id === id ? { ...s, decision: "swap" } : s,
            ),
          })
        )
          fail("Replacement is ineligible for this delivery.");
        sub.decision = decision;
        finish(o);
        return save(o);
      },
    },
    auth: {
      async requestCode(channel, destination) {
        if (!destination.trim()) fail("Enter a destination.");
        const id = uuid();
        challenges.set(id, {
          channel,
          destination,
          expires: Date.now() + 600000,
        });
        return { challengeId: id, demoCode: "123456" };
      },
      async verify(id, code) {
        const c = challenges.get(id);
        if (!c || c.expires <= Date.now() || code !== "123456")
          return fail("Invalid or expired demo code.");
        challenges.delete(id);
        const existing = readDemo<CustomerProfile | null>(
          "demo-profile-identity:v1:" + normalize(c.destination),
          null,
        );
        const p: CustomerProfile = validProfile(existing)
          ? existing
          : {
              id: uuid(),
              name: "Demo customer",
              phone: c.channel === "sms" ? c.destination : "",
              email: c.channel === "email" ? c.destination : "",
              addresses: [],
            };
        persistProfile(p);
        return p;
      },
      async profile() {
        const p = readDemo<CustomerProfile | null>("demo-profile:v1", null);
        return validProfile(p) ? p : null;
      },
      async saveProfile(p) {
        if (!validProfile(p)) fail("Invalid profile.");
        persistProfile(p);
        return clone(p);
      },
      async signOut() {
        writeDemo("demo-profile:v1", null);
      },
    },
    issues: {
      async submit(input) {
        const o = must(input.token);
        if (
          !o.completedAt ||
          Date.now() - Date.parse(o.completedAt) > 48 * 3600000
        )
          fail("Issues must be reported within 48 hours of completion.");
        const issueKey = `demo-issue:v1:${store.id}:${o.id}`;
        if (readDemo<IssueResult | null>(issueKey, null))
          fail("An issue has already been submitted for this order.");
        const selected = [...new Set(input.lineKeys)];
        if (
          !selected.length ||
          selected.some(
            (k) => !effectiveOrderLines(o).some((l) => cartItemKey(l) === k),
          ) ||
          !input.description.trim()
        )
          fail("Select affected items and describe the issue.");
        const amount = orderIssueRefundCents(o, selected);
        const result = {
          id: uuid(),
          refundCents: Math.min(amount, o.finalCents ?? o.quote.totalCents),
          needsReview: amount > store.autoRefundLimitCents,
        };
        writeDemo(issueKey, result);
        return result;
      },
    },
  };
}
