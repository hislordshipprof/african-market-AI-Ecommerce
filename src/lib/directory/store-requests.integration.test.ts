import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma, PrismaClient } from "@prisma/client";
import { testPrismaClient } from "@/lib/test-prisma";
import { clearTestSentEmails, getTestSentEmails, setEmailSenderForTests, type EmailMessage } from "@/lib/email/send";
import { clearTestSentSms, getTestSentSms } from "@/lib/notifications/sms";
import { appUserQuery } from "@/lib/db";
import { notifyWaitingRequests, requestsByArea, submitStoreRequest } from "./store-requests";

const hasDb = !!process.env.DATABASE_URL;
const MI_PER_DEG_LAT = 69.0934;

// North Slope, Alaska: no other test places a store within hundreds of miles.
const ZIP = "99723";
const FAR_ZIP = "99791";

describe.skipIf(!hasDb)("store requests (#455)", () => {
  let raw: PrismaClient;
  let at: { lat: number; lng: number };
  const stamp = Date.now().toString(36);
  const slug = (name: string) => `t455-${name}-${stamp}`;
  const who = (name: string) => `${name}-${stamp}@example.com`;
  // A fresh browser and IP per call, so only the rate-limit test meets the limit.
  let calls = 0;
  const client = () => ({ ip: `ip-${(calls += 1)}-${stamp}`, browser: `b-${calls}-${stamp}` });

  beforeAll(async () => {
    vi.stubEnv("PLATFORM_ROOT_DOMAIN", "shop.example");
    raw = testPrismaClient();
    const zip = await raw.gazetteerZip.findUniqueOrThrow({ where: { zip: ZIP } });
    at = { lat: zip.lat, lng: zip.lng };
  });

  const cleanUp = async () => {
    setEmailSenderForTests(null);
    clearTestSentEmails();
    clearTestSentSms();
    await asAdmin((tx) => tx.directoryStoreRequest.deleteMany({ where: { zip: { in: [ZIP, FAR_ZIP] } } }));
    await raw.store.deleteMany({ where: { slug: { startsWith: "t455-", endsWith: stamp } } });
  };
  beforeEach(cleanUp);
  afterEach(cleanUp);

  afterAll(async () => {
    vi.unstubAllEnvs();
    await raw.$disconnect();
  });

  const request = (contact: string, zip = ZIP) => submitStoreRequest({ zip, contact, consent: true, website: "" }, client());
  const listStore = (name: string, milesNorth: number, extra: Record<string, unknown> = {}) =>
    raw.store.create({ data: { slug: slug(name), name, city: "Utqiagvik", state: "AK", lat: at.lat + milesNorth / MI_PER_DEG_LAT, lng: at.lng, listed: true, ...extra } });
  // The table forces RLS on its owner too; only the platform-admin context reads it.
  const asAdmin = <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) =>
    raw.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      return fn(tx);
    });
  const rows = () => asAdmin((tx) => tx.directoryStoreRequest.findMany({ where: { zip: ZIP }, orderBy: { createdAt: "asc" } }));

  it("stores a request with its consent text; asking twice keeps one row", async () => {
    expect(await request(who("ada"))).toEqual({ ok: true });
    expect(await request(who("ada").toUpperCase())).toEqual({ ok: true });
    const saved = await rows();
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ email: who("ada"), phone: null, notifiedAt: null });
    expect(saved[0]!.consentText).toMatch(/one message/);
  });

  it("refuses a ZIP that is not on the map, and drops honeypot spam without saving", async () => {
    expect(await request(who("ada"), "00000")).toMatchObject({ ok: false });
    expect(await submitStoreRequest({ zip: ZIP, contact: who("bot"), consent: true, website: "x" }, client())).toEqual({ ok: true });
    expect(await rows()).toHaveLength(0);
  });

  it("rate-limits one browser after 5 requests an hour", async () => {
    for (let i = 0; i < 5; i += 1) {
      expect(await submitStoreRequest({ zip: ZIP, contact: who(`r${i}`), consent: true, website: "" }, { ip: `ip-${i}-${stamp}`, browser: `one-${stamp}` })).toEqual({ ok: true });
    }
    const sixth = await submitStoreRequest({ zip: ZIP, contact: who("r6"), consent: true, website: "" }, { ip: `ip-6-${stamp}`, browser: `one-${stamp}` });
    expect(sixth).toMatchObject({ ok: false, message: expect.stringMatching(/Too many/) });
    expect(await rows()).toHaveLength(5);
  });

  it("a shopper (no admin context) can add a request but never read one", async () => {
    await request(who("ada"));
    const seen = await appUserQuery((tx) => tx.$queryRaw<unknown[]>`SELECT id FROM directory_store_requests WHERE zip = ${ZIP}`);
    expect(seen).toEqual([]);
  });

  it("sends one email and one text when a store near the ZIP is listed, then erases the contact", async () => {
    await request(who("ada"));
    await request("(907) 555-2368");
    await listStore("unlisted", 1, { listed: false });
    await listStore("suspended", 2, { status: "suspended" });
    expect(await notifyWaitingRequests()).toMatchObject({ sent: 0 });

    const near = await listStore("near", 10);
    await listStore("further", 30);
    await notifyWaitingRequests();

    const emails = getTestSentEmails().filter((m) => m.to === who("ada"));
    expect(emails).toHaveLength(1);
    expect(emails[0]!.html).toContain("near</a>");
    expect(emails[0]!.html).toContain(`https://${slug("near")}.shop.example/?ref=directory`);
    const texts = getTestSentSms().filter((m) => m.to === "+19075552368");
    expect(texts).toHaveLength(1);
    expect(texts[0]!.text).toContain("10.0 mi from 99723");

    const saved = await rows();
    expect(saved.every((r) => r.notifiedAt && r.notifiedStoreId === near.id && r.email === null && r.phone === null)).toBe(true);

    await listStore("another", 5);
    await notifyWaitingRequests();
    expect(getTestSentEmails().filter((m) => m.to === who("ada"))).toHaveLength(1);
  });

  it("does not notify for a store beyond 50 miles", async () => {
    await request(who("ada"));
    await listStore("far", 50.5);
    await notifyWaitingRequests();
    expect(getTestSentEmails().filter((m) => m.to === who("ada"))).toHaveLength(0);
    expect((await rows())[0]!.notifiedAt).toBeNull();
  });

  it("a failed send stays waiting and resends with the same idempotency key", async () => {
    await request(who("ada"));
    await listStore("near", 3);
    const keys: string[] = [];
    setEmailSenderForTests({
      async send(message: EmailMessage) {
        keys.push(message.idempotencyKey ?? "");
        throw new Error("provider down");
      },
    });
    expect(await notifyWaitingRequests()).toMatchObject({ sent: 0, failed: 1 });
    expect((await rows())[0]!.notifiedAt).toBeNull();
    setEmailSenderForTests({
      async send(message: EmailMessage) {
        keys.push(message.idempotencyKey ?? "");
        return { id: "ok" };
      },
    });
    expect(await notifyWaitingRequests()).toMatchObject({ sent: 1 });
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[0]).toMatch(/^directory-request-/);
  });

  it("platform admins see waiting and sent requests by area, with no contact", async () => {
    await request(who("ada"));
    await request(who("bea"));
    await request(who("cy"), FAR_ZIP);
    await listStore("near", 3);
    await submitStoreRequest({ zip: ZIP, contact: who("late"), consent: true, website: "" }, client());
    await notifyWaitingRequests();
    await request(who("dee"));

    const areas = await requestsByArea();
    const mine = areas.flatMap((a) => a.zips.filter((z) => z.zip === ZIP || z.zip === FAR_ZIP).map((z) => ({ state: a.state, ...z })));
    expect(mine).toEqual(expect.arrayContaining([
      expect.objectContaining({ state: "AK", zip: ZIP, waiting: 1, notified: 3 }),
      expect.objectContaining({ state: "AK", zip: FAR_ZIP, waiting: 1, notified: 0 }),
    ]));
    expect(JSON.stringify(areas)).not.toContain("@example.com");
  });
});
