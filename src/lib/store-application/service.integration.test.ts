import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

vi.mock("next/cache", () => ({
  unstable_cache: (fn: () => unknown) => () => fn(),
  revalidateTag: () => {},
  revalidatePath: () => {},
}));

import { testPrismaClient } from "@/lib/test-prisma";
import { platformAdmin, storeScoped } from "../db";
import { clearTestSentEmails, getTestSentEmails, setEmailSenderForTests, TestSender } from "../email/send";
import { fakeAddressBackend, setAddressProvider, type AddressBackend } from "../address/provider";
import { inngest } from "../inngest/client";
import { COURIER_REGISTRATION_REQUESTED } from "../delivery/courier-registration";
import { withAiOnboardingSettings } from "../admin/platform-settings-test-lock";
import {
  approveStoreApplication,
  deleteExpiredRejectedApplications,
  listStoreApplications,
  rejectStoreApplication,
  submitStoreApplication,
} from "./service";

const run = `${Date.now()}`;
const HOUR = 60 * 60 * 1000;
// Relative to the real clock: the limiter's cleanup drops windows older than a day by Date.now().
const NOW = Date.now();
let seq = 0;

function form(overrides: Record<string, string | null> = {}): Record<string, string | null> {
  seq += 1;
  const n = String(seq).padStart(4, "0");
  return {
    businessName: `Sell Test Market ${run}-${n}`,
    storeType: "african",
    addressLine1: "100 Main St",
    city: "Houston",
    state: "tx",
    zip: "77002",
    ownerName: "Ada Obi",
    email: `Sell-${run}-${n}@Example.com`,
    phone: `(713) 555-${n}`,
    website: "https://instagram.com/sellmarket",
    offersPickup: "on",
    offersDelivery: null,
    fax: null,
    ...overrides,
  };
}

function ip(): string {
  seq += 1;
  return `198.51.100.${seq % 250}-${run}-${seq}`;
}

const actor = { id: `sell-admin-${run}`, email: `sell-admin-${run}@platform.test` };
const platformAdminUser = { id: `sell-pa-${run}`, email: `sell-pa-${run}@platform.test` };

describe.skipIf(!process.env.DATABASE_URL)("store applications (#554)", () => {
  let raw: PrismaClient;

  beforeAll(async () => {
    raw = testPrismaClient();
    await raw.user.create({ data: { id: actor.id, email: actor.email, name: "Sell Admin", emailVerified: true } });
    await raw.user.create({
      data: { ...platformAdminUser, name: "Sell Platform Admin", emailVerified: true, role: "platform_admin" },
    });
    setAddressProvider(fakeAddressBackend());
  });

  afterAll(async () => {
    // Pending rows from earlier runs would push this run's rows out of the capped admin list.
    await platformAdmin.storeApplication.deleteMany({ where: { businessName: { startsWith: `Sell Test Market ${run}-` } } });
    setAddressProvider(null);
    await raw.user.delete({ where: { id: platformAdminUser.id } });
    await raw.$disconnect();
  });

  beforeEach(() => clearTestSentEmails());
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    setEmailSenderForTests(null);
  });

  async function applicationsFor(email: string) {
    return platformAdmin.storeApplication.findMany({ where: { email: email.toLowerCase() } });
  }

  it("stores a valid application with the email lower-cased and the phone in E.164", async () => {
    const input = form();
    const result = await submitStoreApplication(input, ip(), NOW);
    expect(result).toEqual({ ok: true });
    const [row] = await applicationsFor(input.email!);
    expect(row).toMatchObject({
      businessName: input.businessName,
      state: "TX",
      email: input.email!.toLowerCase(),
      offersPickup: true,
      offersDelivery: false,
      status: "pending",
    });
    expect(row.phone).toMatch(/^\+1713555\d{4}$/);
  });

  it("refuses missing fields, a bad phone, email or ZIP and a non-web link without storing anything", async () => {
    const input = form({ businessName: "", phone: "12345", email: "not-an-email", zip: "7700", website: "javascript:alert(1)" });
    const result = await submitStoreApplication(input, ip(), NOW);
    expect(result.ok).toBe(false);
    if (result.ok || !("fieldErrors" in result)) throw new Error("expected field errors");
    expect(Object.keys(result.fieldErrors).sort()).toEqual(["businessName", "email", "phone", "website", "zip"]);
    expect(await applicationsFor("not-an-email")).toHaveLength(0);
  });

  it("a filled honeypot looks accepted but stores nothing", async () => {
    const input = form({ fax: "555-0100" });
    expect(await submitStoreApplication(input, ip(), NOW)).toEqual({ ok: true });
    expect(await applicationsFor(input.email!)).toHaveLength(0);
  });

  it("allows 5 applications an hour per IP and refuses the 6th; another IP is not affected", async () => {
    const shared = ip();
    for (let i = 0; i < 5; i++) {
      expect(await submitStoreApplication(form(), shared, NOW + i)).toEqual({ ok: true });
    }
    const sixth = form();
    expect(await submitStoreApplication(sixth, shared, NOW + 5)).toMatchObject({ ok: false, rateLimited: true });
    expect(await applicationsFor(sixth.email!)).toHaveLength(0);
    expect(await submitStoreApplication(form(), ip(), NOW + 5)).toEqual({ ok: true });
    expect(await submitStoreApplication(form(), shared, NOW + HOUR + 1)).toEqual({ ok: true });
  });

  it("de-duplicates a pending application by email (any case) and by phone", async () => {
    const first = form();
    await submitStoreApplication(first, ip(), NOW);
    const sameEmail = form({ email: first.email!.toUpperCase() });
    expect(await submitStoreApplication(sameEmail, ip(), NOW)).toEqual({ ok: true });
    const samePhone = form({ phone: `+1 ${first.phone}` });
    expect(await submitStoreApplication(samePhone, ip(), NOW)).toEqual({ ok: true });
    expect(await applicationsFor(first.email!)).toHaveLength(1);
    expect(await applicationsFor(samePhone.email!)).toHaveLength(0);
  });

  async function pending(overrides: Record<string, string | null> = {}) {
    const input = form(overrides);
    await submitStoreApplication(input, ip(), NOW);
    const [row] = await applicationsFor(input.email!);
    clearTestSentEmails();
    return row;
  }

  it("the applicant gets one confirmation and each platform admin one email; a duplicate or the honeypot sends nothing (#780)", async () => {
    const input = form();
    expect(await submitStoreApplication(input, ip(), NOW)).toEqual({ ok: true });
    const applicant = input.email!.toLowerCase();
    const toApplicant = getTestSentEmails().filter((m) => m.to === applicant);
    expect(toApplicant).toHaveLength(1);
    expect(toApplicant[0].subject).toContain("We have your application");
    expect(toApplicant[0].html).toContain(input.businessName);
    const toAdmin = getTestSentEmails().filter((m) => m.to === platformAdminUser.email);
    expect(toAdmin).toHaveLength(1);
    expect(toAdmin[0].subject).toContain(input.businessName!);
    expect(toAdmin[0].html).toContain("/admin/applications");

    expect(await submitStoreApplication({ ...input }, ip(), NOW)).toEqual({ ok: true });
    expect(getTestSentEmails().filter((m) => m.to === applicant)).toHaveLength(1);
    expect(getTestSentEmails().filter((m) => m.to === platformAdminUser.email)).toHaveLength(1);

    const bot = form({ fax: "spam" });
    await submitStoreApplication(bot, ip(), NOW);
    expect(getTestSentEmails().filter((m) => m.to === bot.email!.toLowerCase())).toHaveLength(0);
  });

  it("an application is kept when its emails fail (#780)", async () => {
    setEmailSenderForTests({ send: async () => { throw new Error("provider down"); } });
    const input = form();
    expect(await submitStoreApplication(input, ip(), NOW)).toEqual({ ok: true });
    expect(await applicationsFor(input.email!)).toHaveLength(1);
  });

  it("approve sets the store's time zone from its address: Houston, El Paso, New York (#780)", async () => {
    const points: Record<string, { lat: number; lng: number }> = {
      HOUSTON: { lat: 29.7385, lng: -95.3796 },
      "EL PASO": { lat: 31.7619, lng: -106.485 },
      "NEW YORK": { lat: 40.7128, lng: -74.006 },
    };
    const backend: AddressBackend = {
      suggest: async () => [],
      locate: async (parts) => {
        const point = points[parts.city.toUpperCase()];
        if (!point) return { ok: false, code: "no-match" };
        const match = { line1: parts.line1, city: parts.city, state: parts.state, zip: parts.zip, formattedAddress: parts.line1, ...point };
        return { ok: true, match };
      },
    };
    setAddressProvider(backend);
    try {
      const cases = [
        { city: "Houston", state: "TX", zip: "77002", zone: "America/Chicago" },
        { city: "El Paso", state: "TX", zip: "79901", zone: "America/Denver" },
        { city: "New York", state: "NY", zip: "10007", zone: "America/New_York" },
        // No geocode: the state's main zone, not New York's.
        { city: "Nowhere", state: "TX", zip: "75001", zone: "America/Chicago" },
      ];
      for (const [index, place] of cases.entries()) {
        const app = await pending({ city: place.city, state: place.state, zip: place.zip });
        const result = await approveStoreApplication(app.id, `sell-${run}-tz-${index}`, actor);
        if (!result.ok) throw new Error(result.error);
        const store = await platformAdmin.store.findUniqueOrThrow({ where: { id: result.storeId } });
        expect({ city: place.city, timezone: store.timezone }).toEqual({ city: place.city, timezone: place.zone });
      }
    } finally {
      setAddressProvider(fakeAddressBackend());
    }
  });

  it("approve creates one store in setup, invites the owner, queues courier registration and records one audit row, even when approved twice at once", async () => {
    vi.stubEnv("INNGEST_EVENT_KEY", "test-key");
    const send = vi.spyOn(inngest, "send").mockResolvedValue({ ids: [] });
    const app = await pending();
    const slug = `sell-${run}-dup`;
    // Two slugs, so only the claim on the application (not the slug's unique index) can stop the second store.
    const results = await Promise.all([
      approveStoreApplication(app.id, slug, actor),
      approveStoreApplication(app.id, `${slug}-b`, actor),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toHaveLength(1);

    const stores = await platformAdmin.store.findMany({ where: { slug: { in: [slug, `${slug}-b`] } } });
    expect(stores).toHaveLength(1);
    const [store] = stores;
    expect(store).toMatchObject({
      name: app.businessName,
      status: "setup",
      addressLine1: "100 Main St",
      city: "Houston",
      state: "TX",
      zip: "77002",
      pickupEnabled: false,
      phone: app.phone,
    });
    expect(send.mock.calls.map(([event]) => event)).toEqual([
      { name: COURIER_REGISTRATION_REQUESTED, data: { storeId: store.id } },
    ]);

    const after = await platformAdmin.storeApplication.findUniqueOrThrow({ where: { id: app.id } });
    expect(after).toMatchObject({ status: "approved", storeId: store.id, decidedByEmail: actor.email });

    const invites = await platformAdmin.storeInvite.findMany({ where: { storeId: store.id } });
    expect(invites).toHaveLength(1);
    expect(invites[0]).toMatchObject({ email: app.email, role: "owner" });
    expect(getTestSentEmails().filter((m) => m.to === app.email)).toHaveLength(1);

    const audits = await platformAdmin.auditLog.findMany({ where: { entityType: "store_application", entityId: app.id } });
    expect(audits.map((a) => a.action)).toEqual(["store_application.approve"]);
    expect(audits[0].storeId).toBe(store.id);
  });

  it("approve with a taken or reserved slug changes nothing and the application stays pending", async () => {
    const first = await pending();
    const slug = `sell-${run}-taken`;
    expect((await approveStoreApplication(first.id, slug, actor)).ok).toBe(true);
    const second = await pending();
    expect(await approveStoreApplication(second.id, slug, actor)).toMatchObject({ ok: false, field: "slug" });
    expect(await approveStoreApplication(second.id, "admin", actor)).toMatchObject({ ok: false, field: "slug" });
    expect((await platformAdmin.storeApplication.findUniqueOrThrow({ where: { id: second.id } })).status).toBe("pending");
    expect(await platformAdmin.storeInvite.findMany({ where: { email: second.email } })).toHaveLength(0);
  });

  it("reject needs a reason, sends one plain email without the reason, and cannot then be approved", async () => {
    const app = await pending();
    expect(await rejectStoreApplication(app.id, "   ", actor)).toMatchObject({ ok: false });
    expect(getTestSentEmails()).toHaveLength(0);

    const reason = `Internal note ${run}: outside our launch metros`;
    expect(await rejectStoreApplication(app.id, reason, actor)).toMatchObject({ ok: true });
    const mails = getTestSentEmails().filter((m) => m.to === app.email);
    expect(mails).toHaveLength(1);
    expect(mails[0].html).not.toContain("Internal note");
    expect(mails[0].html).not.toContain("launch metros");
    expect(mails[0].subject).not.toContain("Internal note");

    const row = await platformAdmin.storeApplication.findUniqueOrThrow({ where: { id: app.id } });
    expect(row).toMatchObject({ status: "rejected", rejectReason: reason });

    expect((await rejectStoreApplication(app.id, "again", actor)).ok).toBe(false);
    expect(getTestSentEmails().filter((m) => m.to === app.email)).toHaveLength(1);
    expect((await approveStoreApplication(app.id, `sell-${run}-late`, actor)).ok).toBe(false);
    expect(await platformAdmin.store.findMany({ where: { slug: `sell-${run}-late` } })).toHaveLength(0);
  });

  it("a rejection whose email failed is saved, and sending it again mails the applicant once", async () => {
    const app = await pending();
    setEmailSenderForTests({ send: async () => { throw new Error("provider down"); } });
    expect(await rejectStoreApplication(app.id, "Not a food store", actor)).toMatchObject({ ok: true, emailed: false });
    expect((await platformAdmin.storeApplication.findUniqueOrThrow({ where: { id: app.id } })).status).toBe("rejected");

    setEmailSenderForTests(new TestSender());
    expect(await rejectStoreApplication(app.id, "", actor)).toMatchObject({ ok: true, emailed: true });
    expect(getTestSentEmails().filter((m) => m.to === app.email)).toHaveLength(1);
    expect(await rejectStoreApplication(app.id, "", actor)).toMatchObject({ ok: false });
    expect(getTestSentEmails().filter((m) => m.to === app.email)).toHaveLength(1);
  });

  it("a rejected applicant can apply again with the same email", async () => {
    const app = await pending();
    await rejectStoreApplication(app.id, "Not a food store", actor);
    expect(await submitStoreApplication(form({ email: app.email, phone: app.phone }), ip(), NOW)).toEqual({ ok: true });
    expect(await applicationsFor(app.email)).toHaveLength(2);
  });

  it("with the default 12-month retention, deletes rejected applications past it and keeps everything else", async () => {
    const oldRejected = await pending();
    const recentRejected = await pending();
    const oldPending = await pending();
    await rejectStoreApplication(oldRejected.id, "Old", actor);
    await rejectStoreApplication(recentRejected.id, "Recent", actor);
    const now = new Date(Date.UTC(2030, 5, 15));
    const thirteenMonthsAgo = new Date(Date.UTC(2029, 4, 14));
    const elevenMonthsAgo = new Date(Date.UTC(2029, 6, 16));
    await platformAdmin.storeApplication.update({ where: { id: oldRejected.id }, data: { decidedAt: thirteenMonthsAgo } });
    await platformAdmin.storeApplication.update({ where: { id: recentRejected.id }, data: { decidedAt: elevenMonthsAgo } });
    await platformAdmin.storeApplication.update({ where: { id: oldPending.id }, data: { createdAt: thirteenMonthsAgo } });

    const deleted = await withAiOnboardingSettings({ rejectedApplicationRetentionMonths: 12 }, () => deleteExpiredRejectedApplications(now));
    expect(deleted).toBeGreaterThanOrEqual(1);
    const ids = (await platformAdmin.storeApplication.findMany({
      where: { id: { in: [oldRejected.id, recentRejected.id, oldPending.id] } },
      select: { id: true },
    })).map((r) => r.id);
    expect(ids.sort()).toEqual([recentRejected.id, oldPending.id].sort());
  });

  it("reads the retention from the AI and onboarding settings when the job runs (#561)", async () => {
    const fourMonths = await pending();
    const twoMonths = await pending();
    await rejectStoreApplication(fourMonths.id, "Old", actor);
    await rejectStoreApplication(twoMonths.id, "Recent", actor);
    const now = new Date(Date.UTC(2030, 5, 15));
    await platformAdmin.storeApplication.update({ where: { id: fourMonths.id }, data: { decidedAt: new Date(Date.UTC(2030, 1, 15)) } });
    await platformAdmin.storeApplication.update({ where: { id: twoMonths.id }, data: { decidedAt: new Date(Date.UTC(2030, 3, 15)) } });

    await withAiOnboardingSettings({ rejectedApplicationRetentionMonths: 3 }, () => deleteExpiredRejectedApplications(now));
    const ids = (await platformAdmin.storeApplication.findMany({
      where: { id: { in: [fourMonths.id, twoMonths.id] } },
      select: { id: true },
    })).map((r) => r.id);
    expect(ids).toEqual([twoMonths.id]);
  });

  it("lists pending applications apart from decided ones", async () => {
    const waiting = await pending();
    const decided = await pending();
    await rejectStoreApplication(decided.id, "Duplicate", actor);
    const { pending: open, decided: done } = await listStoreApplications();
    expect(open.map((row) => row.id)).toContain(waiting.id);
    expect(open.every((row) => row.status === "pending")).toBe(true);
    expect(done.map((row) => row.id)).toContain(decided.id);
  });

  it("applications are not reachable through a store-scoped client", () => {
    expect("storeApplication" in storeScoped("any-store")).toBe(false);
  });
});
