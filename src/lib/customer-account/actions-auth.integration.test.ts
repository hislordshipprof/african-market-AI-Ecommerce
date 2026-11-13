import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

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
import { ADDRESS_MESSAGES, ADDRESS_NOT_FOUND, SIGN_IN_MESSAGE } from "./address-validation";
import { CARD_NOT_FOUND, CARDS_UNAVAILABLE, SAVED_CARD_PURPOSE, SAVED_CARD_TERMS_VERSION } from "./consent";
import { ensureStripeCustomer } from "./stripe-customer";
import { CheckoutProviderError, fakeCheckoutPayments, fakeDetachCalls, getCheckoutPayments, type NormalizedCard } from "../stripe/checkout-payments";
import { getStripeClient } from "../stripe/provider";
import { verifyUrlFromEmail } from "../test-magic-link";

const hasDb = Boolean(process.env.DATABASE_URL);
const BASE = "http://localhost:3000/api/auth";
const password = "AccountAuth-248!";
const issuedEmails: string[] = [];

function accountEmail(label: string): string {
  const email = `${label}-${Date.now()}-${issuedEmails.length}@example.test`;
  issuedEmails.push(email);
  return email;
}

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
  const href = verifyUrlFromEmail(message?.html);
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

function useFakeStripe(): void {
  vi.stubEnv("E2E_FAKE_STRIPE", "1");
  vi.stubEnv("VERCEL", "");
}

async function savedCardWithConsent(userId: string): Promise<{ paymentMethodId: string; customerId: string }> {
  const customerId = await ensureStripeCustomer(userId);
  const payments = getCheckoutPayments();
  const intent = await payments.createPaymentIntent({
    amount: 100,
    currency: "usd",
    customer: customerId,
    setup_future_usage: "on_session",
    capture_method: "manual",
  });
  const confirmed = await payments.confirmPaymentIntent(intent.id, { payment_method: "pm_card_visa" });
  const paymentMethodId = confirmed.payment_method!;
  await customerScoped(userId).cardSaveConsent.create({
    data: {
      userId,
      paymentIntentId: intent.id,
      paymentMethodId,
      stripeCustomerId: customerId,
      termsVersion: SAVED_CARD_TERMS_VERSION,
      purpose: SAVED_CARD_PURPOSE,
    },
  });
  return { paymentMethodId, customerId };
}

function consentCount(userId: string, paymentMethodId: string): Promise<number> {
  return customerScoped(userId).cardSaveConsent.count({ where: { paymentMethodId } });
}

describe.skipIf(!hasDb)("account actions use the fresh session user", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    if (issuedEmails.length === 0) return;
    await authPrisma.user.deleteMany({ where: { email: { in: issuedEmails } } });
  });

  it("a removal that read the card as attached succeeds when another removal detached it first", async () => {
    useFakeStripe();
    const a = await customerCookie(accountEmail("rae"), "Rae");
    const raced = await savedCardWithConsent(a.id);
    const retrieve = vi.spyOn(fakeCheckoutPayments, "retrievePaymentMethod");
    const detach = vi.spyOn(fakeCheckoutPayments, "detachPaymentMethod");

    let stale: NormalizedCard | undefined;
    let winner: Awaited<ReturnType<typeof removeCardAction>> | undefined;
    retrieve.mockImplementationOnce(async (id) => {
      stale = await fakeCheckoutPayments.retrievePaymentMethod(id);
      winner = await asUser(a.cookie, () => removeCardAction(id));
      return stale;
    });
    const loser = await asUser(a.cookie, () => removeCardAction(raced.paymentMethodId));

    expect(stale?.customer).toBe(raced.customerId);
    expect(detach).toHaveBeenCalledTimes(2);
    expect(fakeDetachCalls().filter((id) => id === raced.paymentMethodId)).toHaveLength(1);
    expect(winner).toMatchObject({ ok: true });
    expect(loser).toMatchObject({ ok: true });
    for (const result of [winner, loser]) {
      if (result?.ok) expect(result.cards.some((card) => card.id === raced.paymentMethodId)).toBe(false);
    }
    expect(await consentCount(a.id, raced.paymentMethodId)).toBe(0);

    const interrupted = await savedCardWithConsent(a.id);
    retrieve.mockImplementationOnce(async (id) => {
      const snapshot = await fakeCheckoutPayments.retrievePaymentMethod(id);
      await getCheckoutPayments().detachPaymentMethod(id);
      return snapshot;
    });
    const settled = await asUser(a.cookie, () => removeCardAction(interrupted.paymentMethodId));
    expect(settled).toMatchObject({ ok: true });
    expect(await consentCount(a.id, interrupted.paymentMethodId)).toBe(0);
  });

  it("a customer cannot touch another customer's consent for a detached card, and the owner's retry clears it", async () => {
    useFakeStripe();
    const a = await customerCookie(accountEmail("ama"), "Ama");
    const b = await customerCookie(accountEmail("ben"), "Ben");
    const { paymentMethodId } = await savedCardWithConsent(a.id);
    await getCheckoutPayments().detachPaymentMethod(paymentMethodId);
    const detach = vi.spyOn(fakeCheckoutPayments, "detachPaymentMethod");

    const asOther = await asUser(b.cookie, () => removeCardAction(paymentMethodId));
    expect(asOther).toMatchObject({ ok: true });
    if (asOther.ok) expect(asOther.cards.some((card) => card.id === paymentMethodId)).toBe(false);
    const other = customerScoped(b.id).cardSaveConsent;
    expect(await other.findMany({ where: { paymentMethodId } })).toEqual([]);
    expect(await other.deleteMany({ where: { paymentMethodId } })).toEqual({ count: 0 });
    expect(await consentCount(a.id, paymentMethodId)).toBe(1);

    const retry = await asUser(a.cookie, () => removeCardAction(paymentMethodId));
    expect(retry).toMatchObject({ ok: true });
    expect(await consentCount(a.id, paymentMethodId)).toBe(0);
    expect(detach).not.toHaveBeenCalled();
  });

  it("a detach failure with the card still attached stays a failure, keeps consent and shows no provider text", async () => {
    useFakeStripe();
    const a = await customerCookie(accountEmail("ike"), "Ike");
    const { paymentMethodId } = await savedCardWithConsent(a.id);
    const readCard = fakeCheckoutPayments.retrievePaymentMethod;
    const detach = vi.spyOn(fakeCheckoutPayments, "detachPaymentMethod");
    const retrieve = vi.spyOn(fakeCheckoutPayments, "retrievePaymentMethod");
    const providerText = "Invalid API Key provided: sk_test_keyLikeText123";
    const log = vi.spyOn(console, "error").mockImplementation(() => {});

    async function expectVisibleFailure(): Promise<void> {
      const result = await asUser(a.cookie, () => removeCardAction(paymentMethodId));
      expect(result).toEqual({ ok: false, error: CARDS_UNAVAILABLE });
      const book = await asUser(a.cookie, () => accountBookAction());
      expect(book.ok && book.cards.some((card) => card.id === paymentMethodId)).toBe(true);
      expect(await consentCount(a.id, paymentMethodId)).toBe(1);
    }

    detach.mockRejectedValueOnce(new CheckoutProviderError("StripeInvalidRequestError", providerText, undefined, 400));
    await expectVisibleFailure();

    detach.mockRejectedValueOnce(new CheckoutProviderError("StripeInvalidRequestError", "Bad request", undefined, 400));
    retrieve
      .mockImplementationOnce(readCard)
      .mockRejectedValueOnce(new CheckoutProviderError("StripeAPIError", providerText, undefined, 500));
    await expectVisibleFailure();

    log.mockClear();
    retrieve.mockClear();
    detach.mockRejectedValueOnce(new CheckoutProviderError("StripeAuthenticationError", providerText, undefined, 401));
    await expectVisibleFailure();
    expect(retrieve).toHaveBeenCalledTimes(1);
    const logged = log.mock.calls.flat().join(" ");
    expect(logged).toContain("401");
    expect(logged).toContain("StripeAuthenticationError");
    expect(logged).not.toContain("keyLikeText");
    expect(logged).not.toContain(paymentMethodId);
  });

  it("refuses a signed-out caller and refuses B on A's address", async () => {
    const signedOut = await asUser("", () => addAddressAction(home));
    expect(signedOut.ok).toBe(false);
    if (!signedOut.ok) expect(signedOut.error).toBe(SIGN_IN_MESSAGE);

    const a = await customerCookie(accountEmail("ada"), "Ada");
    const b = await customerCookie(accountEmail("bea"), "Bea");
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
    const unknownKey = await asUser(a.cookie, () => addAddressAction({ ...home, isDefault: true }));
    expect(unknownKey).toEqual({ ok: false, error: ADDRESS_MESSAGES.invalid });
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

    const a = await customerCookie(accountEmail("cara"), "Cara");
    const b = await customerCookie(accountEmail("bea"), "Bea");
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
      if (!foreignCard.ok) expect(foreignCard.error).toBe(CARD_NOT_FOUND);
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

  describe.skipIf(!process.env.STRIPE_SECRET_KEY)("against the Stripe sandbox", () => {
    const sandboxCustomers: string[] = [];

    afterAll(async () => {
      for (const id of sandboxCustomers) {
        try { await getStripeClient().customers.del(id); } catch { /* already gone */ }
      }
    }, 60_000);

    it("real Stripe: a stale read plus the real not-attached error reports success, and another customer's card stays attached", async () => {
      vi.stubEnv("E2E_FAKE_STRIPE", "");
      const a = await customerCookie(accountEmail("sia"), "Sia");
      const b = await customerCookie(accountEmail("tem"), "Tem");
      const aCustomer = await ensureStripeCustomer(a.id);
      const bCustomer = await ensureStripeCustomer(b.id);
      sandboxCustomers.push(aCustomer, bCustomer);
      const stripe = getStripeClient();
      const aCard = await stripe.paymentMethods.attach("pm_card_visa", { customer: aCustomer });
      const bCard = await stripe.paymentMethods.attach("pm_card_visa", { customer: bCustomer });

      const foreign = await asUser(a.cookie, () => removeCardAction(bCard.id));
      expect(foreign).toEqual({ ok: false, error: CARD_NOT_FOUND });
      expect((await stripe.paymentMethods.retrieve(bCard.id)).customer).toBe(bCustomer);

      const log = vi.spyOn(console, "error");
      const crafted = await asUser(a.cookie, () => removeCardAction("../x"));
      expect(crafted).toEqual({ ok: false, error: CARD_NOT_FOUND });
      expect(log).not.toHaveBeenCalled();

      const detach = vi.spyOn(stripe.paymentMethods, "detach");
      const retrieve = vi.spyOn(stripe.paymentMethods, "retrieve");
      let staleCustomer: unknown;
      let winner: Awaited<ReturnType<typeof removeCardAction>> | undefined;
      retrieve.mockImplementationOnce((async (id: string) => {
        const snapshot = await stripe.paymentMethods.retrieve(id);
        staleCustomer = snapshot.customer;
        winner = await asUser(a.cookie, () => removeCardAction(id));
        return snapshot;
      }) as never);

      const loser = await asUser(a.cookie, () => removeCardAction(aCard.id));

      expect(staleCustomer).toBe(aCustomer);
      expect(winner).toMatchObject({ ok: true });
      expect(loser).toMatchObject({ ok: true });
      if (loser.ok) expect(loser.cards.some((card) => card.id === aCard.id)).toBe(false);
      expect(detach).toHaveBeenCalledTimes(2);
      const second = detach.mock.settledResults[1];
      expect(second?.type).toBe("rejected");
      expect(second?.value).toMatchObject({ type: "StripeInvalidRequestError", statusCode: 400 });
      expect((await stripe.paymentMethods.retrieve(aCard.id)).customer).toBeNull();
    }, 60_000);
  });
});
