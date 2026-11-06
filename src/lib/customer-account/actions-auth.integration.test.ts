import { afterAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.AUTH_RATE_LIMIT_RELAXED = "1";
});

const { headerState, headerAls } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { AsyncLocalStorage } = require("node:async_hooks") as {
    AsyncLocalStorage: typeof import("node:async_hooks").AsyncLocalStorage;
  };
  return {
    headerState: new Headers(),
    headerAls: new AsyncLocalStorage<Headers>(),
  };
});

vi.mock("next/headers", () => ({
  headers: async () => headerAls.getStore() ?? headerState,
}));

import { auth } from "../auth";
import { authPrisma, customerScoped } from "../db";
import { clearTestSentEmails, getTestSentEmails } from "../email/send";
import { addAddressAction, accountBookAction, editAddressAction, removeAddressAction, removeCardAction, savePhoneAction, setDefaultAddressAction } from "./actions";
import { ADDRESS_NOT_FOUND, SIGN_IN_MESSAGE } from "./address-validation";
import { SAVED_CARD_PURPOSE, SAVED_CARD_TERMS_VERSION } from "./consent";
import { ensureStripeCustomer } from "./stripe-customer";
import { getCheckoutPayments } from "../stripe/checkout-payments";

const hasDb = Boolean(process.env.DATABASE_URL);
const BASE = "http://localhost:3000/api/auth";
const RUN = `t248-auth-${Date.now()}`;
const password = "AccountAuth-248!";

class CookieJar {
  private readonly jar = new Map<string, string>();

  apply(response: Response): void {
    for (const raw of response.headers.getSetCookie?.() ?? []) {
      const semi = raw.indexOf(";");
      const pair = (semi === -1 ? raw : raw.slice(0, semi)).trim();
      const eq = pair.indexOf("=");
      if (eq < 1) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value.length === 0) this.jar.delete(name);
      else this.jar.set(name, value);
    }
  }

  header(): string {
    return [...this.jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  }
}

async function authPost(path: string, body: unknown): Promise<Response> {
  return auth.handler(new Request(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
}

async function authGet(url: string): Promise<Response> {
  return auth.handler(new Request(url, { redirect: "manual" }));
}

async function customerCookie(email: string, name: string): Promise<{ id: string; cookie: string }> {
  const signup = await authPost("/sign-up/email", { email, password, name });
  expect(signup.status, await signup.clone().text()).toBe(200);
  const user = await authPrisma.user.findFirstOrThrow({ where: { email } });
  clearTestSentEmails();
  const sent = await authPost("/sign-in/magic-link", { email, callbackURL: "/account" });
  expect(sent.status).toBe(200);
  const message = getTestSentEmails().find((item) => item.to === email);
  const href = message?.html.match(/href="([^"]+)"/)?.[1]?.replace(/&amp;/g, "&");
  expect(href).toBeTruthy();
  const jar = new CookieJar();
  const verify = await authGet(href!);
  expect(verify.status).toBeLessThan(400);
  jar.apply(verify);
  return { id: user.id, cookie: jar.header() };
}

function asUser<T>(cookie: string, run: () => Promise<T>): Promise<T> {
  const headers = new Headers();
  if (cookie) headers.set("cookie", cookie);
  return headerAls.run(headers, run);
}

const home = {
  label: "Home",
  line1: "1 Market St",
  city: "Honolulu",
  state: "HI",
  zip: "96813",
};

describe.skipIf(!hasDb)("account actions use the fresh session user", () => {
  const emails = [`a-${RUN}@example.test`, `b-${RUN}@example.test`, `c-${RUN}@example.test`, `d-${RUN}@example.test`];

  afterAll(async () => {
    await authPrisma.user.deleteMany({ where: { email: { in: emails } } });
  });

  it("refuses a signed-out caller and refuses B on A's address", async () => {
    const signedOut = await asUser("", () => addAddressAction(home));
    expect(signedOut.ok).toBe(false);
    if (!signedOut.ok) expect(signedOut.error).toBe(SIGN_IN_MESSAGE);

    const a = await customerCookie(emails[0], "Ada");
    const b = await customerCookie(emails[1], "Bea");
    const created = await asUser(a.cookie, () => addAddressAction(home));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const addressId = created.address.id;

    const edited = await asUser(b.cookie, () => editAddressAction(addressId, { ...home, label: "Stolen" }));
    expect(edited.ok).toBe(false);
    if (!edited.ok) expect(edited.error).toBe(ADDRESS_NOT_FOUND);

    const removed = await asUser(b.cookie, () => removeAddressAction(addressId));
    expect(removed.ok).toBe(false);

    const phone = await asUser(b.cookie, () => savePhoneAction("(808) 555-0199"));
    expect(phone.ok).toBe(true);

    const forged = await asUser(a.cookie, () => addAddressAction({ ...home, injected: true, notes: { bad: true } }));
    expect(forged.ok).toBe(false);
    expect(await customerScoped(a.id).customerAddress.count()).toBe(1);
    const savedNote = await asUser(a.cookie, () => editAddressAction(addressId, { ...home, notes: "Leave at door" }));
    expect(savedNote.ok).toBe(true);
    const cleared = await asUser(a.cookie, () => editAddressAction(addressId, { ...home, notes: {} }));
    expect(cleared.ok).toBe(false);
    const own = await customerScoped(a.id).customerAddress.findUnique({ where: { id: addressId } });
    expect(own?.notes).toBe("Leave at door");
    expect(own?.label).toBe("Home");
    const aPhone = await customerScoped(a.id).platformCustomerProfile.findUnique({ where: { userId: a.id } });
    expect(aPhone?.phone ?? null).toBeNull();
  });

  it("checks the session on the card, default-address, and account-book actions", async () => {
    const signedOutCard = await asUser("", () => removeCardAction("pm_missing"));
    const signedOutDefault = await asUser("", () => setDefaultAddressAction("missing"));
    const signedOutBook = await asUser("", () => accountBookAction());
    for (const signedOut of [signedOutCard, signedOutDefault, signedOutBook]) {
      expect(signedOut.ok).toBe(false);
      if (!signedOut.ok) expect(signedOut.error).toBe(SIGN_IN_MESSAGE);
    }

    const a = await customerCookie(emails[2], "Cara");
    const b = await customerCookie(emails[3], "Bea");
    const first = await asUser(a.cookie, () => addAddressAction(home));
    const second = await asUser(a.cookie, () => addAddressAction({ ...home, label: "Work", line1: "2 Market St" }));
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    const stolen = await asUser(b.cookie, () => setDefaultAddressAction(second.address.id));
    expect(stolen.ok).toBe(false);
    if (!stolen.ok) expect(stolen.error).toBe(ADDRESS_NOT_FOUND);

    const chosen = await asUser(a.cookie, () => setDefaultAddressAction(second.address.id));
    expect(chosen.ok).toBe(true);
    const stored = await customerScoped(a.id).customerAddress.findUnique({ where: { id: second.address.id } });
    expect(stored?.isDefault).toBe(true);

    const book = await asUser(a.cookie, () => accountBookAction());
    expect(book.ok).toBe(true);
    if (book.ok) expect(book.addresses.some((address) => address.id === second.address.id)).toBe(true);
    const otherBook = await asUser(b.cookie, () => accountBookAction());
    expect(otherBook.ok).toBe(true);
    if (otherBook.ok) expect(otherBook.addresses.some((address) => address.id === second.address.id)).toBe(false);

    const previousFake = process.env.E2E_FAKE_STRIPE;
    const previousCi = process.env.CI;
    const previousVercel = process.env.VERCEL;
    process.env.E2E_FAKE_STRIPE = "1";
    process.env.CI = "true";
    process.env.VERCEL = "";
    try {
      const customerId = await ensureStripeCustomer(a.id);
      const pi = await getCheckoutPayments().createPaymentIntent({
        amount: 100,
        currency: "usd",
        customer: customerId,
        setup_future_usage: "on_session",
        capture_method: "manual",
      }, `auth-card-${a.id}`);
      const confirmed = await getCheckoutPayments().confirmPaymentIntent(pi.id, { payment_method: "pm_card_visa" });
      const paymentMethodId = confirmed.payment_method;
      expect(paymentMethodId).toBeTruthy();
      await customerScoped(a.id).cardSaveConsent.create({
        data: {
          userId: a.id,
          paymentIntentId: pi.id,
          paymentMethodId,
          stripeCustomerId: customerId,
          termsVersion: SAVED_CARD_TERMS_VERSION,
          purpose: SAVED_CARD_PURPOSE,
        },
      });
      const foreignCard = await asUser(b.cookie, () => removeCardAction(paymentMethodId!));
      expect(foreignCard.ok).toBe(false);
      const removed = await asUser(a.cookie, () => removeCardAction(paymentMethodId!));
      expect(removed.ok).toBe(true);
      if (removed.ok) expect(removed.cards.some((card) => card.id === paymentMethodId)).toBe(false);
      const stillThere = await getCheckoutPayments().retrievePaymentMethod(paymentMethodId!);
      expect(stillThere.detached).toBe(true);
    } finally {
      if (previousFake === undefined) delete process.env.E2E_FAKE_STRIPE;
      else process.env.E2E_FAKE_STRIPE = previousFake;
      if (previousCi === undefined) delete process.env.CI;
      else process.env.CI = previousCi;
      if (previousVercel === undefined) delete process.env.VERCEL;
      else process.env.VERCEL = previousVercel;
    }

    const signOut = await auth.handler(new Request(`${BASE}/sign-out`, {
      method: "POST",
      headers: { cookie: a.cookie, origin: "http://localhost:3000" },
    }));
    expect(signOut.status).toBeLessThan(400);
    const revoked = await asUser(a.cookie, () => accountBookAction());
    expect(revoked.ok).toBe(false);
    if (!revoked.ok) expect(revoked.error).toBe(SIGN_IN_MESSAGE);
  });
});
