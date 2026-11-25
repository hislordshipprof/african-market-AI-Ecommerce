import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.AUTH_RATE_LIMIT_RELAXED = "1";
});

const { headerState, fakeState, cache } = vi.hoisted(() => ({
  headerState: new Headers(),
  fakeState: { fetch: (async () => new Response("unscripted", { status: 500 })) as typeof fetch },
  cache: { revalidateTag: vi.fn() },
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
  revalidateTag: (...args: unknown[]) => cache.revalidateTag(...args),
}));
vi.mock("../assistant/model", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../assistant/model")>();
  return {
    ...actual,
    createAssistantModel: () => actual.createAssistantModel({ fetch: fakeState.fetch }),
  };
});

import { generateTOTP } from "../../../e2e/totp";
import { createFakeAnthropicFetch, type FakeAnthropicStep } from "../assistant/messages-api-double";
import { setSpendClock } from "../assistant/spend";
import { storeToday } from "../analytics/range";
import { authPrisma, platformAdmin, storeScoped } from "../db";
import { loadCopilotPanel } from "./turn";
import { confirmCopilotDraft, rejectCopilotDraft, sendCopilotMessage } from "./actions";
import { authPost, testSignUp } from "../test-auth";

const RUN = `t819-${Date.now()}`;
const password = "Copilot-819-Owner!";
const hasDb = !!process.env.DATABASE_URL;
const SPEND_DAY = new Date("2099-11-07T12:00:00.000Z");

class CookieJar {
  private readonly jar = new Map<string, string>();

  apply(response: Response): void {
    for (const raw of response.headers.getSetCookie?.() ?? []) {
      const semi = raw.indexOf(";");
      const pair = (semi === -1 ? raw : raw.slice(0, semi)).trim();
      const eq = pair.indexOf("=");
      if (eq < 1) continue;
      this.jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  header(): string {
    return [...this.jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  }
}

async function enableTwoFactor(email: string): Promise<string> {
  const jar = new CookieJar();
  const signedIn = await authPost("/sign-in/email", { email, password });
  expect(signedIn.status, await signedIn.clone().text()).toBe(200);
  jar.apply(signedIn);
  const enabled = await authPost("/two-factor/enable", { password }, jar.header());
  expect(enabled.status, await enabled.clone().text()).toBe(200);
  jar.apply(enabled);
  const body = (await enabled.json()) as { totpURI?: string };
  const secret = new URL(body.totpURI ?? "http://localhost").searchParams.get("secret");
  expect(secret).toBeTruthy();
  const verified = await authPost("/two-factor/verify-totp", { code: generateTOTP(secret!) }, jar.header());
  expect(verified.status, await verified.clone().text()).toBe(200);
  jar.apply(verified);
  return jar.header();
}

function asStore(slug: string, cookies: string): void {
  headerState.set("cookie", cookies);
  headerState.set("x-store-slug", slug);
}

/** Pro by default: the chat is a Pro feature (#818). Null removes the subscription, which is Starter. */
async function setPlan(storeId: string, plan: "pro" | null): Promise<void> {
  await authPrisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL ROLE app_user`;
    await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
    await tx.storeSubscription.deleteMany({ where: { storeId } });
    if (plan) await tx.storeSubscription.create({ data: { storeId, plan, status: "active" } });
  });
}

function script(steps: FakeAnthropicStep[]) {
  const fake = createFakeAnthropicFetch({ expectedKey: "sk-ant-test", steps });
  fakeState.fetch = fake.fetch;
  return fake;
}

const WEEK = Object.fromEntries(
  ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"].map((day) => [day, "9:00 AM - 8:00 PM"]),
);

describe.skipIf(!hasDb)("copilot drafts: coupons, prices and store changes (#819)", () => {
  const storeId = crypto.randomUUID();
  const slug = `d-${RUN}`;
  const email = `owner-${RUN}@example.com`;
  const staffEmail = `staff-${RUN}@example.com`;
  let cookies = "";
  let staffCookies = "";
  const variant: Record<string, string> = {};
  let yamId = "";
  let gariId = "";

  beforeAll(async () => {
    setSpendClock(() => SPEND_DAY);
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    vi.stubEnv("ASSISTANT_MODEL", "");
    vi.stubEnv("ASSISTANT_SPEND_CAP_USD", "1000000");
    for (const [address, name] of [[email, "Owner"], [staffEmail, "Staff"]] as const) {
      const res = await testSignUp({ email: address, password, name });
      expect(res.status, await res.clone().text()).toBe(200);
    }
    const ownerId = (await authPrisma.user.findFirstOrThrow({ where: { email } })).id;
    const staffId = (await authPrisma.user.findFirstOrThrow({ where: { email: staffEmail } })).id;
    await authPrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await tx.$executeRaw`INSERT INTO stores (id, name, slug, status, hours, timezone, store_delivery_enabled, updated_at) VALUES (${storeId}, ${"Drafts " + RUN}, ${slug}, 'active', ${JSON.stringify(WEEK)}::jsonb, 'America/New_York', true, now())`;
      await tx.$executeRaw`INSERT INTO store_memberships (id, store_id, user_id, role, updated_at) VALUES (${crypto.randomUUID()}, ${storeId}, ${ownerId}, 'owner', now())`;
      await tx.$executeRaw`INSERT INTO store_memberships (id, store_id, user_id, role, updated_at) VALUES (${crypto.randomUUID()}, ${storeId}, ${staffId}, 'staff', now())`;
    });
    await setPlan(storeId, "pro");
    const listing = async (name: string, variants: Array<[string, number]>) => {
      const created = await storeScoped(storeId).listing.create({
        data: {
          storeId,
          customName: name,
          price: Math.min(...variants.map(([, price]) => price)),
          stockMode: "counted",
          qty: 10,
          variants: { create: variants.map(([label, price]) => ({ label, price, weightG: 500 })) },
        },
        include: { variants: true },
      });
      for (const v of created.variants) variant[`${name} ${v.label}`] = v.id;
      return created.id;
    };
    yamId = await listing("Yam", [["1 lb", 300], ["5 lb", 1200]]);
    await listing("Yam flour", [["2 lb", 450]]);
    gariId = await listing("Gari", [["5 lb", 850], ["10 lb", 1500]]);
    await listing("Rice", [["10 lb", 1800]]);
    cookies = await enableTwoFactor(email);
    staffCookies = await enableTwoFactor(staffEmail);
  }, 90_000);

  afterAll(() => {
    setSpendClock(null);
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    asStore(slug, cookies);
    cache.revalidateTag.mockClear();
  });

  async function send(text: string, steps: FakeAnthropicStep[]) {
    script(steps);
    const sent = await sendCopilotMessage({ messageId: crypto.randomUUID(), text });
    expect(sent.ok, JSON.stringify(sent)).toBe(true);
    if (!sent.ok) throw new Error("send failed");
    return sent;
  }

  it("a coupon sentence becomes a draft; nothing exists until the owner confirms, and an edit is validated like the promotions page", async () => {
    const sent = await send("10% off over $30 this weekend", [
      {
        kind: "tool",
        toolName: "draft_coupon",
        toolInput: { code: "weekend10", percentOff: 10, minGoods: 30, startsAt: "2099-11-28T00:00", endsAt: "2099-11-29T23:59" },
      },
      { kind: "text", text: "I drafted WEEKEND10: 10% off orders over $30, Saturday and Sunday." },
    ]);
    expect(sent.drafts).toHaveLength(1);
    const card = sent.drafts[0]!;
    expect(card).toMatchObject({ kind: "coupon", state: "pending" });
    if (card.kind !== "coupon") return;
    expect(card.fields).toMatchObject({ code: "WEEKEND10", kind: "percent", percentOff: "10", minGoods: "30.00", startsAt: "2099-11-28T00:00", endsAt: "2099-11-29T23:59" });
    expect(await storeScoped(storeId).storeCoupon.count()).toBe(0);

    asStore(slug, staffCookies);
    await expect(confirmCopilotDraft({ draftId: card.id })).rejects.toThrow();
    asStore(slug, cookies);

    const refused = await confirmCopilotDraft({ draftId: card.id, coupon: { ...card.fields, percentOff: "95" } });
    expect(refused).toMatchObject({ ok: false, code: "invalid" });
    expect(await storeScoped(storeId).storeCoupon.count()).toBe(0);

    const confirmed = await confirmCopilotDraft({ draftId: card.id, coupon: { ...card.fields, code: "WKND10" } });
    expect(confirmed).toMatchObject({ ok: true, draft: { state: "confirmed" } });
    const coupon = await storeScoped(storeId).storeCoupon.findFirstOrThrow();
    expect(coupon).toMatchObject({ code: "WKND10", kind: "percent", percentOff: 10, minGoodsCents: 3000 });
    expect(coupon.startsAt.toISOString()).toBe("2099-11-28T05:00:00.000Z");
    expect(await storeScoped(storeId).auditLog.count({ where: { action: "coupon.create", entityId: coupon.id } })).toBe(1);
    expect(await confirmCopilotDraft({ draftId: card.id })).toMatchObject({ ok: true });
    expect(await storeScoped(storeId).storeCoupon.count()).toBe(1);
  });

  it("an invalid coupon is refused at draft time with the promotions page's reason", async () => {
    const sent = await send("90% off forever with code X", [
      { kind: "tool", toolName: "draft_coupon", toolInput: { code: "X", percentOff: 10, startsAt: "2099-11-28T00:00" } },
      { kind: "text", text: "That code is too short." },
    ]);
    expect(sent.drafts).toHaveLength(0);
  });

  it("raise all yams by 50 cents drafts every matched yam line with before and after; unticked lines and other listings are not written", async () => {
    const fake = await send("raise all yams by 50 cents", [
      { kind: "tool", toolName: "draft_price_change", toolInput: { query: "yam", change: "add", cents: 50 } },
      { kind: "text", text: "Here are the yam prices, each up 50 cents." },
    ]);
    expect(fake.drafts).toHaveLength(1);
    const card = fake.drafts[0]!;
    if (card.kind !== "price") throw new Error("expected a price card");
    expect(card.lines.map((line) => [line.name, line.beforeCents, line.afterCents]).sort()).toEqual([
      ["Yam 1 lb", 300, 350],
      ["Yam 5 lb", 1200, 1250],
      ["Yam flour 2 lb", 450, 500],
    ]);
    expect((await storeScoped(storeId).listingVariant.findUniqueOrThrow({ where: { id: variant["Yam 1 lb"]! } })).price).toBe(300);

    const result = await confirmCopilotDraft({ draftId: card.id, variantIds: [variant["Yam 1 lb"], variant["Yam 5 lb"]] });
    expect(result).toMatchObject({ ok: true, draft: { state: "confirmed" } });
    const price = async (key: string) => (await storeScoped(storeId).listingVariant.findUniqueOrThrow({ where: { id: variant[key]! } })).price;
    expect(await price("Yam 1 lb")).toBe(350);
    expect(await price("Yam 5 lb")).toBe(1250);
    expect(await price("Yam flour 2 lb")).toBe(450);
    expect(await price("Gari 5 lb")).toBe(850);
    expect((await storeScoped(storeId).listing.findUniqueOrThrow({ where: { id: yamId } })).price).toBe(350);
    expect(await storeScoped(storeId).auditLog.count({ where: { action: "listing.variant_price_change", entityId: yamId } })).toBe(1);
  });

  it("set Gari 5 lb to $9.99 drafts one line; a price changed since asks again instead of applying", async () => {
    const sent = await send("set Gari 5 lb to $9.99", [
      { kind: "tool", toolName: "draft_price_change", toolInput: { query: "gari", variant: "5 lb", change: "set", cents: 999 } },
      { kind: "text", text: "Gari 5 lb from $8.50 to $9.99." },
    ]);
    const card = sent.drafts[0]!;
    if (card.kind !== "price") throw new Error("expected a price card");
    expect(card.lines.map((line) => [line.name, line.beforeCents, line.afterCents])).toEqual([["Gari 5 lb", 850, 999]]);
    await storeScoped(storeId).listingVariant.update({ where: { id: variant["Gari 5 lb"]! }, data: { price: 900 } });
    expect(await confirmCopilotDraft({ draftId: card.id })).toMatchObject({ ok: false, code: "stale" });
    expect((await storeScoped(storeId).listingVariant.findUniqueOrThrow({ where: { id: variant["Gari 5 lb"]! } })).price).toBe(900);
    expect(gariId).toBeTruthy();
  });

  it("a price draft refuses a listing the owner did not name and a price below one cent", async () => {
    const sent = await send("lower yam flour by $5", [
      { kind: "tool", toolName: "draft_price_change", toolInput: { query: "rice", change: "add", cents: -500 } },
      { kind: "tool", toolName: "draft_price_change", toolInput: { query: "yam flour", change: "add", cents: -500 } },
      { kind: "text", text: "I could not draft that." },
    ]);
    expect(sent.drafts).toHaveLength(0);
  });

  it("closed tomorrow drafts a one-day closure that says when it ends; weekly hours stay and it applies on confirm", async () => {
    const today = storeToday("America/New_York");
    const tomorrow = new Date(Date.parse(`${today}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    const sent = await send("closed tomorrow", [
      { kind: "tool", toolName: "draft_store_change", toolInput: { change: "closed", date: tomorrow } },
      { kind: "text", text: "Closed tomorrow, one day only." },
    ]);
    const card = sent.drafts[0]!;
    if (card.kind !== "store_change") throw new Error("expected a store change card");
    expect(card.endsAt).toBeTruthy();
    expect(card.text).toMatch(/one day only/i);
    expect(card.ends).toBe(`the end of ${new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }).format(new Date(`${tomorrow}T12:00:00Z`)).replace(",", "")}`);
    expect(await confirmCopilotDraft({ draftId: card.id })).toMatchObject({ ok: true });
    const store = await platformAdmin.store.findUniqueOrThrow({ where: { id: storeId }, select: { hours: true } });
    expect((store.hours as Record<string, unknown>).monday).toBe("9:00 AM - 8:00 PM");
    expect((store.hours as { dates: Record<string, string> }).dates[tomorrow]).toBe("Closed");
  });

  it("close early today at 6 keeps today's opening time; pause delivery today ends tonight", async () => {
    const today = storeToday("America/New_York");
    const sent = await send("close early today at 6 and pause delivery today", [
      { kind: "tool", toolName: "draft_store_change", toolInput: { change: "hours", date: today, close: "18:00" } },
      { kind: "tool", toolName: "draft_store_change", toolInput: { change: "pause_delivery", until: today } },
      { kind: "text", text: "Drafted both." },
    ]);
    expect(sent.drafts.map((d) => d.kind)).toEqual(["store_change", "store_change"]);
    const [hours, pause] = sent.drafts;
    if (hours?.kind !== "store_change" || pause?.kind !== "store_change") throw new Error("expected store change cards");
    expect(hours.text).toMatch(/9:00 AM to 6:00 PM/);
    expect(await confirmCopilotDraft({ draftId: pause.id })).toMatchObject({ ok: true });
    const store = await platformAdmin.store.findUniqueOrThrow({ where: { id: storeId }, select: { deliveryPausedUntil: true } });
    expect(store.deliveryPausedUntil?.toISOString()).toBe(pause.endsAt);
  });

  it("a draft not confirmed within 24 hours expires, and a dismissed draft writes nothing", async () => {
    const sent = await send("set rice 10 lb to $19", [
      { kind: "tool", toolName: "draft_price_change", toolInput: { query: "rice", change: "set", cents: 1900 } },
      { kind: "tool", toolName: "draft_coupon", toolInput: { code: "RICE5", amountOff: 5, startsAt: "2099-11-28T00:00" } },
      { kind: "text", text: "Drafted." },
    ]);
    const [price, coupon] = sent.drafts;
    const row = await storeScoped(storeId).copilotDraft.findUniqueOrThrow({ where: { id: price!.id } });
    const hours = (row.expiresAt.getTime() - row.createdAt.getTime()) / 3_600_000;
    expect(hours).toBeGreaterThan(23.9);
    expect(hours).toBeLessThanOrEqual(24.01);
    await storeScoped(storeId).copilotDraft.update({ where: { id: price!.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await confirmCopilotDraft({ draftId: price!.id })).toMatchObject({ ok: false, code: "expired" });
    expect(await rejectCopilotDraft({ draftId: coupon!.id })).toEqual({ ok: true });
    expect(await confirmCopilotDraft({ draftId: coupon!.id })).toMatchObject({ ok: false, code: "not_found" });
    expect(await storeScoped(storeId).storeCoupon.count({ where: { code: "RICE5" } })).toBe(0);
    const panel = await loadCopilotPanel(storeId, (await authPrisma.user.findFirstOrThrow({ where: { email } })).id);
    expect(panel.drafts.find((d) => d.id === price!.id)?.state).toBe("expired");
  });
});
