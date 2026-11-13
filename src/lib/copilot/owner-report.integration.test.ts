import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.AUTH_RATE_LIMIT_RELAXED = "1";
});

const { headerState, fakeState, bucket } = vi.hoisted(() => ({
  headerState: new Headers(),
  fakeState: {
    fetch: (async () => new Response("unscripted", { status: 500 })) as typeof fetch,
    onPut: null as null | (() => Promise<void>),
  },
  bucket: new Map<string, { bucket: string; contentType: string }>(),
}));

vi.mock("next/headers", () => ({ headers: async () => headerState }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("next/cache", () => ({
  unstable_cache: (fn: () => unknown) => () => fn(),
  revalidateTag: () => {},
}));
vi.mock("../assistant/model", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../assistant/model")>();
  return { ...actual, createAssistantModel: () => actual.createAssistantModel({ fetch: fakeState.fetch }) };
});
// R2 write keys are withheld from this lane: the S3 client is a recording fake.
vi.mock("@aws-sdk/client-s3", () => {
  class PutObjectCommand {
    constructor(readonly input: { Bucket: string; Key: string; ContentType: string }) {}
  }
  class GetObjectCommand {
    constructor(readonly input: { Key: string }) {}
  }
  class DeleteObjectCommand {
    constructor(readonly input: { Bucket: string; Key: string }) {}
  }
  class S3Client {
    async send(command: PutObjectCommand | GetObjectCommand | DeleteObjectCommand) {
      if (command instanceof PutObjectCommand) {
        bucket.set(command.input.Key, { bucket: command.input.Bucket, contentType: command.input.ContentType });
        await fakeState.onPut?.();
        return {};
      }
      if (command instanceof DeleteObjectCommand) {
        if (bucket.get(command.input.Key)?.bucket !== command.input.Bucket) throw new Error("NoSuchKey");
        bucket.delete(command.input.Key);
        return {};
      }
      throw new Error("NoSuchKey");
    }
  }
  return { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand };
});

import sharp from "sharp";
import { generateTOTP } from "../../../e2e/totp";
import { createFakeAnthropicFetch, type FakeAnthropicStep } from "../assistant/messages-api-double";
import { setSpendClock } from "../assistant/spend";
import { auth } from "../auth";
import { authPrisma, platformAdmin, storeScoped } from "../db";
import { replyToThreadAction } from "../support/store-actions";
import { READ_ONLY_MESSAGE } from "../store-admin/session";
import { listPendingOwnerReports, matchReportItem, REPORTS_LOCKED_MESSAGE } from "./owner-report";
import { confirmOwnerReportItems, submitPhotoReport, submitVoiceReport } from "./report-actions";

const BASE = "http://localhost:3000/api/auth";
const RUN = `t21-${Date.now()}`;
const password = "Owner-Report-21!";
const hasDb = !!process.env.DATABASE_URL;

async function authPost(path: string, body: unknown, cookies?: string): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cookies) headers.cookie = cookies;
  return auth.handler(new Request(`${BASE}${path}`, { method: "POST", headers, body: JSON.stringify(body) }));
}

function cookiesOf(response: Response, jar: Map<string, string>): string {
  for (const raw of response.headers.getSetCookie?.() ?? []) {
    const pair = raw.split(";")[0]!.trim();
    const eq = pair.indexOf("=");
    if (eq > 0) jar.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

async function signIn(email: string, twoFactor: boolean): Promise<string> {
  const jar = new Map<string, string>();
  const signedIn = await authPost("/sign-in/email", { email, password });
  expect(signedIn.status, await signedIn.clone().text()).toBe(200);
  let cookies = cookiesOf(signedIn, jar);
  if (!twoFactor) return cookies;
  const enabled = await authPost("/two-factor/enable", { password }, cookies);
  expect(enabled.status, await enabled.clone().text()).toBe(200);
  cookies = cookiesOf(enabled, jar);
  const secret = new URL(((await enabled.json()) as { totpURI: string }).totpURI).searchParams.get("secret")!;
  const verified = await authPost("/two-factor/verify-totp", { code: generateTOTP(secret) }, cookies);
  expect(verified.status, await verified.clone().text()).toBe(200);
  return cookiesOf(verified, jar);
}

function asStore(slug: string, cookies: string): void {
  headerState.set("cookie", cookies);
  headerState.set("x-store-slug", slug);
}

function extraction(items: Array<{ name: string; quantity: number | null }>) {
  const steps: FakeAnthropicStep[] = [{ kind: "tool", toolName: "report_items", toolInput: { items } }];
  const fake = createFakeAnthropicFetch({ expectedKey: "sk-ant-test", steps });
  fakeState.fetch = fake.fetch;
  return fake;
}

describe.skipIf(!hasDb)("owner reports (real auth, lane database)", () => {
  const storeAId = crypto.randomUUID();
  const storeBId = crypto.randomUUID();
  const slugA = `ra-${RUN}`;
  const slugB = `rb-${RUN}`;
  const emails = {
    owner: `owner-${RUN}@example.com`,
    staff: `staff-${RUN}@example.com`,
    no2fa: `no2fa-${RUN}@example.com`,
    outsider: `outsider-${RUN}@example.com`,
  };
  const cookies = { owner: "", staff: "", no2fa: "", outsider: "" };
  const ids = { egusi: "", palm: "", gari: "", pepper: "", ugwu: "" };

  beforeAll(async () => {
    setSpendClock(() => new Date("2099-11-10T12:00:00.000Z"));
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    vi.stubEnv("ASSISTANT_MODEL", "");
    vi.stubEnv("ASSISTANT_SPEND_CAP_USD", "1000000");
    vi.stubEnv("R2_PROOF_BUCKET", "proof-test");
    vi.stubEnv("R2_ACCOUNT_ID", "test");
    vi.stubEnv("R2_ACCESS_KEY_ID", "test");
    vi.stubEnv("R2_SECRET_ACCESS_KEY", "test");

    for (const email of Object.values(emails)) {
      const res = await authPost("/sign-up/email", { email, password, name: email.split("@")[0] });
      expect(res.status, await res.clone().text()).toBe(200);
    }
    const userId = async (email: string) => (await authPrisma.user.findFirstOrThrow({ where: { email } })).id;
    const [ownerId, staffId, no2faId, outsiderId] = await Promise.all(Object.values(emails).map(userId));

    await authPrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await tx.$executeRaw`INSERT INTO stores (id, name, slug, status, updated_at) VALUES (${storeAId}, ${"Report A " + RUN}, ${slugA}, 'active', now())`;
      await tx.$executeRaw`INSERT INTO stores (id, name, slug, status, updated_at) VALUES (${storeBId}, ${"Report B " + RUN}, ${slugB}, 'active', now())`;
      for (const [store, user, role] of [
        [storeAId, ownerId, "owner"],
        [storeAId, staffId, "staff"],
        [storeAId, no2faId, "staff"],
        [storeBId, outsiderId, "owner"],
      ] as const) {
        await tx.$executeRaw`INSERT INTO store_memberships (id, store_id, user_id, role, updated_at) VALUES (${crypto.randomUUID()}, ${store}, ${user}, ${role}, now())`;
      }
      // Voice and photo reports are Pro (ADR-0021); store B stays on Starter.
      await tx.$executeRaw`INSERT INTO store_subscriptions (store_id, plan, status) VALUES (${storeAId}, 'pro', 'active')`;
      const pepper = await tx.masterProduct.create({ data: { name: `Scotch Bonnet ${RUN}` } });
      await tx.productSynonym.create({ data: { productId: pepper.id, term: "ata rodo" } });
      await tx.$executeRaw`SELECT set_config('app.store_id', ${storeAId}, true)`;
      ids.pepper = (await tx.listing.create({
        data: { storeId: storeAId, masterProductId: pepper.id, price: 300, stockMode: "counted", qty: 1 },
      })).id;
    });

    const old = new Date("2020-01-01T00:00:00.000Z");
    const counted = async (name: string, qty: number) => (await storeScoped(storeAId).listing.create({
      data: { storeId: storeAId, customName: name, price: 500, stockMode: "counted", qty, confidence: 0.3, confidenceUpdatedAt: old },
    })).id;
    ids.egusi = await counted("Egusi, ground", 3);
    ids.palm = await counted("Palm Oil 1L", 2);
    ids.gari = await counted("Gari 2kg", 5);
    ids.ugwu = (await storeScoped(storeAId).listing.create({
      data: { storeId: storeAId, customName: "Ugwu leaves", price: 400, stockMode: "status", status: "out_of_stock", confidence: 0.3, confidenceUpdatedAt: old },
    })).id;

    cookies.owner = await signIn(emails.owner, true);
    cookies.staff = await signIn(emails.staff, true);
    cookies.outsider = await signIn(emails.outsider, true);
    cookies.no2fa = await signIn(emails.no2fa, false);
  }, 120_000);

  afterAll(() => {
    setSpendClock(null);
    vi.unstubAllEnvs();
  });

  beforeEach(() => asStore(slugA, cookies.owner));

  it("plan gate: a Starter store's voice report is refused before any model call", async () => {
    asStore(slugB, cookies.outsider);
    expect(await submitVoiceReport({ transcript: "got one gari" })).toEqual({
      ok: false,
      code: "plan_locked",
      message: REPORTS_LOCKED_MESSAGE,
    });
    expect(await storeScoped(storeBId).ownerReport.count()).toBe(0);
  });

  it("downgrade: staff over the Starter limit keep read-only access; the earliest staff and the owner still write", async () => {
    const outsiderId = (await authPrisma.user.findFirstOrThrow({ where: { email: emails.outsider } })).id;
    await platformAdmin.storeMembership.create({ data: { storeId: storeAId, userId: outsiderId, role: "staff" } });
    await platformAdmin.storeSubscription.update({ where: { storeId: storeAId }, data: { plan: "starter" } });
    try {
      const reply = { threadId: "no-such-thread", body: "On our way" };
      asStore(slugA, cookies.outsider);
      expect(await replyToThreadAction(reply)).toEqual({ ok: false, error: READ_ONLY_MESSAGE });
      expect(await submitVoiceReport({ transcript: "got one gari" })).toEqual({ ok: false, code: "read_only", message: READ_ONLY_MESSAGE });
      asStore(slugA, cookies.staff);
      expect(await replyToThreadAction(reply)).toEqual({ ok: false, error: "Thread not found" });
      asStore(slugA, cookies.owner);
      expect(await replyToThreadAction(reply)).toEqual({ ok: false, error: "Thread not found" });

      await platformAdmin.storeSubscription.update({ where: { storeId: storeAId }, data: { plan: "pro" } });
      asStore(slugA, cookies.outsider);
      expect(await replyToThreadAction(reply)).toEqual({ ok: false, error: "Thread not found" });
    } finally {
      await platformAdmin.storeSubscription.update({ where: { storeId: storeAId }, data: { plan: "pro" } });
      await platformAdmin.storeMembership.deleteMany({ where: { storeId: storeAId, userId: outsiderId } });
    }
  });

  it("matcher: a listing name, a synonym, and no match", async () => {
    const egusi = await matchReportItem(storeAId, { name: "egusi", quantity: 20, unit: null });
    expect(egusi).toMatchObject({ listingId: ids.egusi, kind: "restock" });
    expect(egusi!.confidence).toBeGreaterThanOrEqual(0.9);
    expect(await matchReportItem(storeAId, { name: "ata rodo", quantity: 2, unit: null })).toMatchObject({ listingId: ids.pepper });
    expect(await matchReportItem(storeAId, { name: "dragon fruit juice", quantity: 6, unit: null })).toBeNull();
    expect(await matchReportItem(storeAId, { name: "Ugwu", quantity: 2, unit: null })).toMatchObject({ listingId: ids.ugwu, kind: "set_status" });
  });

  it("AC1: a voice note becomes restock lines; one tap writes stock, confidence and audit", async () => {
    extraction([{ name: "egusi", quantity: 20 }, { name: "palm oil", quantity: 15 }]);
    const sent = await submitVoiceReport({ transcript: "Got 20 bags of egusi and 15 bottles of palm oil" });
    expect(sent.ok).toBe(true);
    if (!sent.ok) return;
    expect(sent.report.items.map((item) => [item.listingId, item.proposedDelta, item.status])).toEqual([
      [ids.egusi, 20, "pending"],
      [ids.palm, 15, "pending"],
    ]);
    expect(await storeScoped(storeAId).stockEvent.count({ where: { listingId: { in: [ids.egusi, ids.palm] } } })).toBe(0);

    const confirmed = await confirmOwnerReportItems({ reportId: sent.report.id, itemIds: sent.report.items.map((item) => item.id) });
    expect(confirmed.ok && confirmed.report.status).toBe("confirmed");
    const egusi = await storeScoped(storeAId).listing.findUniqueOrThrow({ where: { id: ids.egusi } });
    const palm = await storeScoped(storeAId).listing.findUniqueOrThrow({ where: { id: ids.palm } });
    expect([egusi.qty, palm.qty, egusi.confidence, palm.confidence]).toEqual([23, 17, 1, 1]);
    const events = await storeScoped(storeAId).stockEvent.findMany({ where: { listingId: { in: [ids.egusi, ids.palm] } } });
    expect(events.map((event) => [event.type, event.delta]).sort()).toEqual([["restock", 15], ["restock", 20]]);
    expect(await storeScoped(storeAId).auditLog.count({ where: { action: "owner_report.confirm", entityId: sent.report.id } })).toBe(2);
    expect(await storeScoped(storeAId).auditLog.count({ where: { action: "owner_report.propose", entityId: sent.report.id } })).toBe(1);

    // Writes from the report stay in store A.
    expect(await storeScoped(storeBId).stockEvent.count({ where: { listingId: ids.egusi } })).toBe(0);
    expect(await storeScoped(storeBId).auditLog.count({ where: { entityId: sent.report.id } })).toBe(0);
    expect(await confirmOwnerReportItems({ reportId: sent.report.id, itemIds: [] })).toEqual({ ok: false, code: "already_decided" });
  });

  it("AC2 + AC3: an invoice photo goes to private storage; matched lines restock, unmatched lines are shown and never written", async () => {
    const fake = extraction([
      { name: "Egusi 5kg", quantity: 4 },
      { name: "Gari 2kg", quantity: 10 },
      { name: "Dragon Fruit Juice", quantity: 6 },
    ]);
    const jpeg = await sharp({ create: { width: 16, height: 16, channels: 3, background: "#eee" } }).jpeg().toBuffer();
    const form = new FormData();
    form.set("type", "invoice_photo");
    form.set("photo", new File([new Uint8Array(jpeg)], "invoice.jpg", { type: "image/jpeg" }));
    const sent = await submitPhotoReport(form);
    expect(sent.ok).toBe(true);
    if (!sent.ok) return;

    const stored = await storeScoped(storeAId).ownerReport.findUniqueOrThrow({ where: { id: sent.report.id } });
    expect(stored.imageKey).toBe(`owner-reports/${storeAId}/${sent.report.id}.jpg`);
    expect(bucket.get(stored.imageKey!)).toEqual({ bucket: "proof-test", contentType: "image/jpeg" });
    expect(JSON.stringify(fake.requests[0]!.body!.messages)).toContain("\"type\":\"image\"");

    const [egusi, gari, juice] = sent.report.items;
    expect([egusi!.listingId, egusi!.proposedDelta]).toEqual([ids.egusi, 4]);
    expect([gari!.listingId, gari!.proposedDelta]).toEqual([ids.gari, 10]);
    expect(juice).toMatchObject({ extractedName: "Dragon Fruit Juice", extractedQty: 6, listingId: null, status: "unmatched" });

    const egusiBefore = (await storeScoped(storeAId).listing.findUniqueOrThrow({ where: { id: ids.egusi } })).qty!;
    const events = await storeScoped(storeAId).stockEvent.count();
    const confirmed = await confirmOwnerReportItems({ reportId: sent.report.id, itemIds: [gari!.id, juice!.id] });
    expect(confirmed.ok).toBe(true);
    if (!confirmed.ok) return;
    expect(confirmed.report.status).toBe("partial");
    expect(confirmed.report.items.map((item) => item.status)).toEqual(["rejected", "confirmed", "unmatched"]);
    expect((await storeScoped(storeAId).listing.findUniqueOrThrow({ where: { id: ids.gari } })).qty).toBe(15);
    expect((await storeScoped(storeAId).listing.findUniqueOrThrow({ where: { id: ids.egusi } })).qty).toBe(egusiBefore);
    expect(await storeScoped(storeAId).stockEvent.count()).toBe(events + 1);
    const rejected = await storeScoped(storeAId).auditLog.findMany({ where: { action: "owner_report.reject", entityId: sent.report.id } });
    expect(rejected.map((row) => (row.after as { itemIds: string[] }).itemIds)).toEqual([[egusi!.id]]);
  });

  it("a photo whose report cannot be stored after the upload leaves no object in storage", async () => {
    extraction([{ name: "Gone Yam", quantity: 3 }]);
    const gone = (await storeScoped(storeAId).listing.create({
      data: { storeId: storeAId, customName: "Gone Yam", price: 500, stockMode: "counted", qty: 1 },
    })).id;
    fakeState.onPut = async () => {
      await storeScoped(storeAId).listing.delete({ where: { id: gone } });
    };
    const jpeg = await sharp({ create: { width: 16, height: 16, channels: 3, background: "#ddd" } }).jpeg().toBuffer();
    const form = new FormData();
    form.set("type", "shelf_photo");
    form.set("photo", new File([new Uint8Array(jpeg)], "shelf.jpg", { type: "image/jpeg" }));
    const keysBefore = bucket.size;
    vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await submitPhotoReport(form)).toMatchObject({ ok: false, code: "copilot_unavailable" });
    } finally {
      fakeState.onPut = null;
      vi.restoreAllMocks();
    }
    expect(bucket.size).toBe(keysBefore);
  });

  it("a ticked line that no longer fits stays pending with a notice, and can be confirmed once it fits", async () => {
    const yam = (await storeScoped(storeAId).listing.create({
      data: { storeId: storeAId, customName: "Water Yam", price: 500, stockMode: "counted", qty: 1 },
    })).id;
    extraction([{ name: "egusi", quantity: 1 }, { name: "water yam", quantity: 2 }, { name: "gari", quantity: 1 }]);
    const sent = await submitVoiceReport({ transcript: "one egusi, two water yam and one gari" });
    expect(sent.ok).toBe(true);
    if (!sent.ok) return;
    const [egusi, waterYam, gari] = sent.report.items;
    expect(waterYam!.listingId).toBe(yam);
    await storeScoped(storeAId).listing.update({ where: { id: yam }, data: { active: false } });

    const first = await confirmOwnerReportItems({ reportId: sent.report.id, itemIds: [egusi!.id, waterYam!.id] });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.notChanged).toBe(1);
    expect(first.report.status).toBe("pending");
    expect(first.report.items.map((item) => item.status)).toEqual(["confirmed", "pending", "rejected"]);
    expect((await storeScoped(storeAId).listing.findUniqueOrThrow({ where: { id: yam } })).qty).toBe(1);

    await storeScoped(storeAId).listing.update({ where: { id: yam }, data: { active: true } });
    const second = await confirmOwnerReportItems({ reportId: sent.report.id, itemIds: [waterYam!.id] });
    expect(second.ok && [second.report.status, second.notChanged]).toEqual(["partial", 0]);
    expect((await storeScoped(storeAId).listing.findUniqueOrThrow({ where: { id: yam } })).qty).toBe(3);
    expect(await storeScoped(storeAId).auditLog.count({ where: { action: "owner_report.confirm", entityId: sent.report.id } })).toBe(2);
    expect(gari!.listingId).toBe(ids.gari);
  });

  it("the same report sent twice at once makes one pending report", async () => {
    extraction([{ name: "palm oil", quantity: 4 }]);
    const transcript = `four palm oil ${RUN}`;
    const [a, b] = await Promise.all([submitVoiceReport({ transcript }), submitVoiceReport({ transcript })]);
    expect(a.ok && b.ok && a.report.id === b.report.id).toBe(true);
    expect(await storeScoped(storeAId).ownerReport.count({ where: { rawTranscript: transcript } })).toBe(1);
  });

  it("a report not settled in the same page view comes back as pending, newest first, until dismissed", async () => {
    extraction([{ name: "egusi", quantity: 2 }, { name: "Dragon Fruit Juice", quantity: 6 }]);
    const sent = await submitVoiceReport({ transcript: "two egusi and six dragon fruit juice" });
    expect(sent.ok).toBe(true);
    if (!sent.ok) return;

    const pending = await listPendingOwnerReports(storeAId);
    expect(pending[0]).toEqual(sent.report);
    expect(pending[0]!.items.map((item) => item.status)).toEqual(["pending", "unmatched"]);
    expect(pending.every((report) => report.status === "pending")).toBe(true);
    expect(await listPendingOwnerReports(storeBId)).toEqual([]);

    const dismissed = await confirmOwnerReportItems({ reportId: sent.report.id, itemIds: [] });
    expect(dismissed.ok && dismissed.report.status).toBe("rejected");
    expect((await listPendingOwnerReports(storeAId)).map((report) => report.id)).not.toContain(sent.report.id);
    expect(await storeScoped(storeAId).auditLog.count({ where: { action: "owner_report.reject", entityId: sent.report.id } })).toBe(1);
  });

  it("a status listing's line sets it in stock", async () => {
    extraction([{ name: "ugwu", quantity: 3 }]);
    const sent = await submitVoiceReport({ transcript: "ugwu is back, three bunches" });
    expect(sent.ok).toBe(true);
    if (!sent.ok) return;
    await confirmOwnerReportItems({ reportId: sent.report.id, itemIds: [sent.report.items[0]!.id] });
    const ugwu = await storeScoped(storeAId).listing.findUniqueOrThrow({ where: { id: ids.ugwu } });
    expect([ugwu.status, ugwu.confidence]).toEqual(["in_stock", 1]);
  });

  it("auth: members submit, only the owner confirms; others are redirected", async () => {
    extraction([{ name: "gari", quantity: 1 }]);
    asStore(slugA, cookies.staff);
    const sent = await submitVoiceReport({ transcript: "got one gari" });
    expect(sent.ok).toBe(true);
    if (!sent.ok) return;
    const confirm = { reportId: sent.report.id, itemIds: [sent.report.items[0]!.id] };
    await expect(confirmOwnerReportItems(confirm)).rejects.toThrow(/NEXT_REDIRECT:/);

    for (const who of ["", cookies.no2fa, cookies.outsider]) {
      asStore(slugA, who);
      await expect(submitVoiceReport({ transcript: "got one gari" })).rejects.toThrow(/NEXT_REDIRECT:/);
      await expect(submitPhotoReport(new FormData())).rejects.toThrow(/NEXT_REDIRECT:/);
      await expect(confirmOwnerReportItems(confirm)).rejects.toThrow(/NEXT_REDIRECT:/);
    }

    asStore(slugB, cookies.outsider);
    expect(await confirmOwnerReportItems(confirm)).toEqual({ ok: false, code: "not_found" });

    asStore(slugA, cookies.owner);
    const confirmed = await confirmOwnerReportItems(confirm);
    expect(confirmed.ok && confirmed.report.status).toBe("confirmed");
  });
});
