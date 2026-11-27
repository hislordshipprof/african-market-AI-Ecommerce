import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { state } = vi.hoisted(() => ({ state: { headers: new Headers(), cartId: "" } }));

vi.mock("next/headers", () => ({
  headers: async () => state.headers,
  cookies: async () => ({
    get: (name: string) => (name === "cart_id" && state.cartId ? { name, value: state.cartId } : undefined),
    getAll: () => [],
    has: () => false,
    set: () => {},
    delete: () => {},
  }),
}));
vi.mock("next/cache", () => ({ unstable_cache: (fn: () => unknown) => () => fn(), revalidateTag: () => {}, revalidatePath: () => {} }));

import type { Prisma, PrismaClient } from "@prisma/client";
import { testPrismaClient } from "@/lib/test-prisma";
import { platformAdmin, storeScoped } from "../db";
import { clearTestSentEmails, getTestSentEmails } from "../email/send";
import { fakeAddressBackend, setAddressProvider } from "../address/provider";
import { resetFakeCheckoutPayments } from "../stripe/checkout-payments";
import { submitStoreApplicationAction } from "../store-application/actions";
import { requestStoreNotice } from "../directory/request-actions";
import { createPaymentIntentAction } from "../checkout/actions";
import * as checkoutService from "../checkout/service";
import { TURNSTILE_FAILED } from "./turnstile";
import { stubTurnstile, TURNSTILE_DUMMY_TOKEN } from "./turnstile-fake";

const hasDb = !!process.env.DATABASE_URL;
const RUN = `t872-${Date.now().toString(36)}`;
// North Slope, Alaska, as in the store-request tests: no store nearby.
const ZIP = "99723";
const CONTACT = { name: "Ada Buyer", phone: "+15551234567", email: "ada@t872.test" };
let seq = 0;
const ip = () => `192.0.2.${(seq += 1) % 250}-${RUN}`;

describe.skipIf(!hasDb)("Turnstile on the public forms (#872)", () => {
  let raw: PrismaClient;
  let storeId = "";
  let variantId = "";

  const asAdmin = <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) =>
    raw.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      return fn(tx);
    });

  beforeAll(async () => {
    raw = testPrismaClient();
    setAddressProvider(fakeAddressBackend());
    const store = await raw.store.create({
      data: { slug: RUN, name: "Turnstile Market", status: "active", stripeOnboardingStatus: "complete", stripeAccountId: `acct_${RUN}`, pickupEnabled: true },
    });
    storeId = store.id;
    const scoped = storeScoped(storeId);
    const listing = await scoped.listing.create({ data: { storeId, customName: "Garri", price: 1200, stockMode: "unlimited" } });
    variantId = (await scoped.listingVariant.create({ data: { listingId: listing.id, label: "4 lb", price: 1200, weightG: 1814 } })).id;
  });

  beforeEach(() => {
    vi.stubEnv("E2E_FAKE_STRIPE", "1");
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("CI", "true");
    clearTestSentEmails();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    setAddressProvider(null);
    await platformAdmin.storeApplication.deleteMany({ where: { businessName: { startsWith: `Turnstile ${RUN}` } } });
    await asAdmin((tx) => tx.directoryStoreRequest.deleteMany({ where: { zip: ZIP } }));
    const scoped = storeScoped(storeId);
    await scoped.cartLine.deleteMany({});
    await scoped.cart.deleteMany({});
    await scoped.listingVariant.deleteMany({});
    await scoped.listing.deleteMany({});
    await raw.store.deleteMany({ where: { id: storeId } });
    resetFakeCheckoutPayments();
    await raw.$disconnect();
  });

  describe("the store application on /sell (fails closed)", () => {
    const email = (n: string) => `turnstile-${n}-${RUN}@example.com`;
    function application(n: string, token?: string): FormData {
      const form = new FormData();
      const fields: Record<string, string> = {
        businessName: `Turnstile ${RUN} ${n}`, storeType: "african", addressLine1: "100 Main St", city: "Houston", state: "TX",
        zip: "77002", ownerName: "Ada Obi", email: email(n), phone: `(713) 555-0${String((seq += 1) % 1000).padStart(3, "0")}`, offersPickup: "on", planChoice: "pro",
      };
      for (const [key, value] of Object.entries(fields)) form.set(key, value);
      if (token) form.set("cf-turnstile-response", token);
      return form;
    }
    const submit = (form: FormData) => {
      state.headers = new Headers({ "x-platform-root": "1", host: "globegrocer.com", "x-forwarded-for": ip() });
      return submitStoreApplicationAction({ status: "idle" }, form);
    };
    const rows = (n: string) => platformAdmin.storeApplication.count({ where: { email: email(n) } });

    it("refuses a missing token, a failed one, and siteverify being down, storing and sending nothing", async () => {
      stubTurnstile("pass");
      expect(await submit(application("missing"))).toMatchObject({ status: "error", message: TURNSTILE_FAILED });
      stubTurnstile("fail");
      expect(await submit(application("failed", TURNSTILE_DUMMY_TOKEN))).toMatchObject({ status: "error", message: TURNSTILE_FAILED });
      stubTurnstile("down");
      expect(await submit(application("down", TURNSTILE_DUMMY_TOKEN))).toMatchObject({ status: "error", message: TURNSTILE_FAILED });
      expect(await rows("missing") + await rows("failed") + await rows("down")).toBe(0);
      expect(getTestSentEmails()).toHaveLength(0);
    });

    it("takes the application with a passing token, and with the keys unset as before", async () => {
      stubTurnstile("pass");
      expect(await submit(application("passed", TURNSTILE_DUMMY_TOKEN))).toEqual({ status: "sent" });
      vi.unstubAllEnvs();
      vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "");
      vi.stubEnv("TURNSTILE_SECRET_KEY", "");
      expect(await submit(application("unset"))).toEqual({ status: "sent" });
      expect(await rows("passed") + await rows("unset")).toBe(2);
    });
  });

  describe("the store suggestion form (fails closed)", () => {
    const ask = (contact: string, token?: string) => {
      state.headers = new Headers({ host: "globegrocer.com", "x-forwarded-for": ip() });
      return requestStoreNotice({ zip: ZIP, contact, consent: true, website: "" }, token);
    };
    const rows = () => asAdmin((tx) => tx.directoryStoreRequest.count({ where: { zip: ZIP } }));

    it("refuses a missing, failed or unverifiable token without a row; a passing token is stored", async () => {
      stubTurnstile("pass");
      expect(await ask(`a-${RUN}@example.com`)).toEqual({ ok: false, message: TURNSTILE_FAILED });
      stubTurnstile("fail");
      expect(await ask(`b-${RUN}@example.com`, TURNSTILE_DUMMY_TOKEN)).toEqual({ ok: false, message: TURNSTILE_FAILED });
      stubTurnstile("down");
      expect(await ask(`c-${RUN}@example.com`, TURNSTILE_DUMMY_TOKEN)).toEqual({ ok: false, message: TURNSTILE_FAILED });
      expect(await rows()).toBe(0);
      stubTurnstile("pass");
      expect(await ask(`d-${RUN}@example.com`, TURNSTILE_DUMMY_TOKEN)).toEqual({ ok: true });
      expect(await rows()).toBe(1);
    });
  });

  describe("checkout (fails open)", () => {
    async function pay(token?: string) {
      state.headers = new Headers({ "x-store-slug": RUN, host: `${RUN}.globegrocer.com`, "x-forwarded-for": ip() });
      const scoped = storeScoped(storeId);
      const cart = await scoped.cart.create({ data: { storeId } });
      await scoped.cartLine.create({ data: { storeId, cartId: cart.id, variantId, qty: 4, swapRule: "exact_only" } });
      state.cartId = cart.id;
      return createPaymentIntentAction(CONTACT, "pickup", undefined, undefined, undefined, token);
    }

    it("a missing or failed token holds no card; siteverify down still takes the payment, logged", async () => {
      const intent = vi.spyOn(checkoutService, "createPaymentIntent");
      stubTurnstile("pass");
      expect(await pay()).toEqual({ ok: false, error: TURNSTILE_FAILED });
      stubTurnstile("fail");
      expect(await pay(TURNSTILE_DUMMY_TOKEN)).toEqual({ ok: false, error: TURNSTILE_FAILED });
      expect(intent).not.toHaveBeenCalled();

      const warn = vi.spyOn(console, "warn");
      stubTurnstile("down");
      expect(await pay(TURNSTILE_DUMMY_TOKEN)).toMatchObject({ ok: true, clientSecret: expect.any(String) });
      expect(warn.mock.calls.map((call) => String(call[0])).join("\n")).toContain("turnstile_checkout_failed_open");
      stubTurnstile("pass");
      expect(await pay(TURNSTILE_DUMMY_TOKEN)).toMatchObject({ ok: true, clientSecret: expect.any(String) });
      expect(intent).toHaveBeenCalledTimes(2);
    });
  });
});
