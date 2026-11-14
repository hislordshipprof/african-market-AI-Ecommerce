import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { testPrismaClient } from "@/lib/test-prisma";
import { storeScoped, storeScopedTransaction } from "../db";
import { clearTestSentEmails, getTestSentEmails, setEmailSenderForTests, TestSender } from "../email/send";
import { makeFakeStep } from "../inngest/fake-step";
import { isRlsRejection } from "../listing/cross-store-write";
import { copilotDailyDigest, localClock } from "./digest";

type Handler = (ctx: { step: ReturnType<typeof makeFakeStep> }) => Promise<unknown>;
const digestHandler = (copilotDailyDigest as unknown as { fn: Handler }).fn;

const hasDb = !!process.env.DATABASE_URL;
const RUN = `t433-${Date.now().toString(36)}`;
/** 20:00 in Chicago (CST, UTC-6). */
const CHICAGO_8PM = new Date("2026-11-11T02:00:00Z");
const EARLIER_TODAY = new Date("2026-11-11T00:30:00Z");
const YESTERDAY = new Date("2026-11-10T03:00:00Z");

describe.skipIf(!hasDb)("copilot daily digest (lane database)", () => {
  let raw: PrismaClient;
  const owners = [`digest-owner1-${RUN}`, `digest-owner2-${RUN}`];
  const staffA = `digest-staff-${RUN}`;
  const ownerB = `digest-ownerb-${RUN}`;
  let storeAId = "";
  let storeBId = "";

  beforeAll(async () => {
    raw = testPrismaClient();
    storeAId = (await raw.store.create({
      data: { slug: `digest-a-${RUN}`, name: "Digest A", timezone: "America/Chicago", digestHour: 20 },
    })).id;
    storeBId = (await raw.store.create({
      data: { slug: `digest-b-${RUN}`, name: "Digest B", timezone: "America/Chicago", digestHour: 21 },
    })).id;
    await raw.user.createMany({
      data: [...owners, staffA, ownerB].map((id) => ({ id, name: id, email: `${id}@example.com` })),
    });
    await storeScoped(storeAId).storeMembership.createMany({
      data: [
        ...owners.map((userId) => ({ storeId: storeAId, userId, role: "owner" })),
        { storeId: storeAId, userId: staffA, role: "staff" },
      ],
    });
    await storeScoped(storeBId).storeMembership.create({ data: { storeId: storeBId, userId: ownerB, role: "owner" } });

    const a = storeScoped(storeAId);
    const yam = (await a.listing.create({
      data: { storeId: storeAId, customName: "Puna Yam", price: 500, stockMode: "counted", qty: 3, confidence: 1 },
    })).id;
    const gari = (await a.listing.create({
      data: { storeId: storeAId, customName: "Gari Ijebu", price: 400, stockMode: "status", status: "in_stock", confidence: 0.1 },
    })).id;
    await a.copilotAlert.createMany({
      data: [
        { storeId: storeAId, kind: "running_low", listingId: yam, dedupeKey: `running_low:${yam}`, createdAt: EARLIER_TODAY },
        { storeId: storeAId, kind: "sold_out", listingId: yam, dedupeKey: `sold_out:${yam}:old`, createdAt: YESTERDAY },
        { storeId: storeAId, kind: "confirm_request", listingId: gari, dedupeKey: `confirm_request:${gari}`, createdAt: YESTERDAY },
      ],
    });
    await a.stockEvent.createMany({
      data: [
        { storeId: storeAId, listingId: yam, type: "sale", delta: -4, actorId: owners[0]!, createdAt: EARLIER_TODAY },
        { storeId: storeAId, listingId: gari, type: "sale", delta: -1, actorId: owners[0]!, createdAt: EARLIER_TODAY },
        { storeId: storeAId, listingId: gari, type: "sale", delta: -9, actorId: owners[0]!, createdAt: YESTERDAY },
      ],
    });
    const customerId = (await a.customer.create({
      data: { storeId: storeAId, name: "Digest Buyer", email: `digest-buyer-${RUN}@example.com` },
    })).id;
    await a.order.create({
      data: {
        storeId: storeAId, number: 1, customerId, status: "AUTHORIZED", fulfillment: "pickup",
        subtotalCents: 1000, bufferCents: 0, totalCents: 1000, totalAuthorizedCents: 1000, createdAt: EARLIER_TODAY,
      },
    });

    const b = storeScoped(storeBId);
    await b.listing.create({
      data: { storeId: storeBId, customName: "Store B Plantain", price: 300, stockMode: "counted", qty: 1, confidence: 1 },
    });
  });

  beforeEach(() => {
    clearTestSentEmails();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(CHICAGO_8PM);
  });

  afterEach(() => {
    setEmailSenderForTests(null);
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await raw.$disconnect();
  });

  const digestRows = (storeId: string) => storeScopedTransaction(storeId, (tx) => tx.copilotDigest.count());
  const sentTo = (userId: string) => getTestSentEmails().filter((email) => email.to === `${userId}@example.com`);

  it("at 20:00 Chicago one email goes to each owner of the 20:00 store with only its data, once across two runs; the 21:00 store gets nothing", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test");
    await digestHandler({ step: makeFakeStep() });
    await digestHandler({ step: makeFakeStep() });

    for (const owner of owners) expect(sentTo(owner)).toHaveLength(1);
    expect(sentTo(staffA)).toHaveLength(0);
    expect(sentTo(ownerB)).toHaveLength(0);
    expect(await digestRows(storeAId)).toBe(1);

    const html = sentTo(owners[0]!)[0]!.html;
    expect(html).toContain("Puna Yam is running low");
    expect(html).not.toContain("is sold out");
    expect(html).toContain("Do you still have Gari Ijebu?");
    expect(html).toMatch(/Orders today: 1\b/);
    expect(html).toContain("Gari Ijebu: 1 sold");
    expect(html.indexOf("Puna Yam: 4 sold")).toBeGreaterThan(-1);
    expect(html.indexOf("Puna Yam: 4 sold")).toBeLessThan(html.indexOf("Gari Ijebu: 1 sold"));
    expect(html).not.toContain("Store B Plantain");
  });

  it("a store whose second owner's send fails is retried in the same run, and the data changing in between causes no 409", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test");
    const storeCId = (await raw.store.create({
      data: { slug: `digest-c-${RUN}`, name: "Digest C", timezone: "America/Chicago", digestHour: 20 },
    })).id;
    const ownersC = [`digest-ownerc1-${RUN}`, `digest-ownerc2-${RUN}`];
    await raw.user.createMany({ data: ownersC.map((id) => ({ id, name: id, email: `${id}@example.com` })) });
    await storeScoped(storeCId).storeMembership.createMany({
      data: ownersC.map((userId) => ({ storeId: storeCId, userId, role: "owner" })),
    });
    const fufu = (await storeScoped(storeCId).listing.create({
      data: { storeId: storeCId, customName: "Fufu Flour", price: 600, stockMode: "counted", qty: 0, confidence: 1 },
    })).id;
    const real = new TestSender();
    let failedOnce = false;
    setEmailSenderForTests({
      async send(message) {
        if (message.to === `${ownersC[1]}@example.com` && !failedOnce) {
          failedOnce = true;
          await storeScoped(storeCId).copilotAlert.create({
            data: { storeId: storeCId, kind: "sold_out", listingId: fufu, dedupeKey: `sold_out:${fufu}` },
          });
          throw new Error("Resend API error 503");
        }
        return real.send(message);
      },
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    await digestHandler({ step: makeFakeStep() });

    expect(failedOnce).toBe(true);
    for (const owner of ownersC) expect(sentTo(owner)).toHaveLength(1);
    expect(sentTo(ownersC[1]!)[0]!.html).toBe(sentTo(ownersC[0]!)[0]!.html);
  });

  it("copilot_digests: storeScoped(B) reads none of A's digest rows, cannot insert one for A, and updates nothing", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test");
    await digestHandler({ step: makeFakeStep() });

    expect(await storeScopedTransaction(storeBId, (tx) => tx.copilotDigest.findMany())).toEqual([]);
    await expect(storeScopedTransaction(storeBId, (tx) =>
      tx.copilotDigest.create({ data: { storeId: storeAId, localDate: "2026-11-12", html: "x" } }),
    )).rejects.toSatisfy(isRlsRejection);
    expect((await storeScopedTransaction(storeBId, (tx) =>
      tx.copilotDigest.updateMany({ where: { storeId: storeAId }, data: { html: "tampered" } }))).count).toBe(0);
    expect(await digestRows(storeAId)).toBe(1);
  });

  it("without RESEND_API_KEY it logs one warning, sends nothing and succeeds", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await raw.store.update({ where: { id: storeBId }, data: { digestHour: 20 } });

    await expect(digestHandler({ step: makeFakeStep() })).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(getTestSentEmails()).toHaveLength(0);
    expect(await digestRows(storeBId)).toBe(0);
  });
});

describe("localClock", () => {
  it("starts the day at local midnight on DST-change days", () => {
    expect(localClock("America/Chicago", new Date("2026-03-09T01:00:00Z")).dayStart.toISOString()).toBe("2026-03-08T06:00:00.000Z");
    expect(localClock("America/Chicago", new Date("2026-11-02T02:00:00Z")).dayStart.toISOString()).toBe("2026-11-01T05:00:00.000Z");
  });
});
