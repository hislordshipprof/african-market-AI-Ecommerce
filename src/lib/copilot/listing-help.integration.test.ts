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
import { authPrisma, platformAdmin, storeScoped } from "../db";
import { loadCopilotPanel } from "./turn";
import { confirmCopilotDraft, sendCopilotMessage } from "./actions";
import { authPost, testSignUp } from "../test-auth";

const RUN = `t820-${Date.now()}`;
const password = "Copilot-820-Owner!";
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

function script(steps: FakeAnthropicStep[]) {
  const fake = createFakeAnthropicFetch({ expectedKey: "sk-ant-test", steps });
  fakeState.fetch = fake.fetch;
  return fake;
}

const WEEK = Object.fromEntries(
  ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"].map((day) => [day, "9:00 AM - 8:00 PM"]),
);

describe.skipIf(!hasDb)("copilot listing help: what needs fixing and description drafts (#820)", () => {
  const storeId = crypto.randomUUID();
  const slug = `lh-${RUN}`;
  const email = `owner-${RUN}@example.com`;
  const staffEmail = `staff-${RUN}@example.com`;
  let cookies = "";
  let staffCookies = "";
  const ids: Record<string, string> = {};
  let aisleId = "";

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
      await tx.$executeRaw`INSERT INTO stores (id, name, slug, status, hours, timezone, store_delivery_enabled, updated_at) VALUES (${storeId}, ${"Help " + RUN}, ${slug}, 'active', ${JSON.stringify(WEEK)}::jsonb, 'America/New_York', true, now())`;
      await tx.$executeRaw`INSERT INTO store_memberships (id, store_id, user_id, role, updated_at) VALUES (${crypto.randomUUID()}, ${storeId}, ${ownerId}, 'owner', now())`;
      await tx.$executeRaw`INSERT INTO store_memberships (id, store_id, user_id, role, updated_at) VALUES (${crypto.randomUUID()}, ${storeId}, ${staffId}, 'staff', now())`;
      await tx.storeSubscription.create({ data: { storeId, plan: "pro", status: "active" } });
    });
    aisleId = (await platformAdmin.category.findFirstOrThrow({ select: { id: true } })).id;
    const egusi = await platformAdmin.masterProduct.create({
      data: { name: `Qegusi ${RUN}`, categoryId: aisleId, originCountries: "Nigeria", unit: "1 lb", imageUrl: "https://example.com/egusi.jpg" },
    });
    const listing = async (key: string, data: Record<string, unknown>) => {
      const created = await storeScoped(storeId).listing.create({
        data: {
          storeId,
          price: 699,
          stockMode: "status",
          status: "in_stock",
          variants: { create: [{ label: "1 lb", price: 699, weightG: 454 }] },
          ...data,
        } as never,
      });
      ids[key] = created.id;
    };
    const photo = "https://example.com/own.jpg";
    await listing("complete", { customName: "Complete thing", categoryId: aisleId, imageUrl: photo, description: "Ready." });
    await listing("noPhoto", { customName: "Photo-less thing", categoryId: aisleId, description: "Ready." });
    await listing("noAisle", { customName: "Aisle-less thing", imageUrl: photo, description: "Ready." });
    await listing("noDescription", { customName: "Egusi 1 lb", masterProductId: egusi.id });
    await listing("noAllergens", { customName: "Jollof tray", categoryId: aisleId, imageUrl: photo, description: "Hot.", prepared: "hot", prepMinutes: 15 });
    await listing("inactive", { customName: "Retired thing", active: false });
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

  it("what needs fixing lists active listings missing a photo, aisle, description or prepared-food allergens, each with a link to fix it", async () => {
    const fake = script([
      { kind: "tool", toolName: "listings_to_fix", toolInput: {} },
      { kind: "text", text: "4 listings need fixing." },
    ]);
    const sent = await sendCopilotMessage({ messageId: crypto.randomUUID(), text: "What needs fixing in my listings?" });
    if (!sent.ok) throw new Error(JSON.stringify(sent));
    expect(sent.reply).toBe("4 listings need fixing.");
    const fixes = new Map(sent.fixes.map((fix) => [fix.listingId, fix]));
    expect([...fixes.keys()].sort()).toEqual([ids.noPhoto, ids.noAisle, ids.noDescription, ids.noAllergens].sort());
    expect(fixes.get(ids.noPhoto!)?.missing).toEqual(["photo"]);
    expect(fixes.get(ids.noAisle!)?.missing).toEqual(["aisle"]);
    expect(fixes.get(ids.noDescription!)?.missing).toEqual(["description"]);
    expect(fixes.get(ids.noAllergens!)?.missing).toEqual(["allergens"]);
    expect(fixes.get(ids.noPhoto!)?.href).toBe(`/store-admin/listings?store=${slug}&edit=${ids.noPhoto}`);
    expect(fixes.get(ids.noAllergens!)?.href).toBe(`/store-admin/listings?store=${slug}&allergens=${ids.noAllergens}`);
    // The model was given the listing data, not asked to guess.
    expect(JSON.stringify(fake.requests.at(-1))).toContain("Photo-less thing");

    const panel = await loadCopilotPanel(storeId, (await authPrisma.user.findFirstOrThrow({ where: { email } })).id);
    expect(panel.messages.at(-1)?.fixes?.map((fix) => fix.listingId).sort()).toEqual([...fixes.keys()].sort());
  });

  it("write a description drafts the text from the listing's facts; confirm saves it through the listing path", async () => {
    const fake = script([
      { kind: "tool", toolName: "listing_facts", toolInput: { query: "egusi" } },
      { kind: "tool", toolName: "draft_description", toolInput: { listingId: ids.noDescription, text: "Ground egusi melon seeds from Nigeria, 1 lb. Used to thicken egusi soup." } },
      { kind: "text", text: "I drafted a description for Egusi 1 lb." },
    ]);
    const sent = await sendCopilotMessage({ messageId: crypto.randomUUID(), text: "Write a description for Egusi 1 lb" });
    if (!sent.ok) throw new Error(JSON.stringify(sent));
    const facts = JSON.stringify(fake.requests.at(-1));
    expect(facts).toContain("Nigeria");
    expect(sent.drafts).toHaveLength(1);
    const card = sent.drafts[0]!;
    if (card.kind !== "description") throw new Error("expected a description card");
    expect(card).toMatchObject({ listingId: ids.noDescription, name: "Egusi 1 lb", state: "pending" });
    expect(card.text).toMatch(/^Ground egusi/);
    expect((await storeScoped(storeId).listing.findUniqueOrThrow({ where: { id: ids.noDescription! } })).description).toBeNull();

    asStore(slug, staffCookies);
    await expect(confirmCopilotDraft({ draftId: card.id })).rejects.toThrow();
    asStore(slug, cookies);

    const confirmed = await confirmCopilotDraft({ draftId: card.id, description: "Ground egusi melon seeds from Nigeria. For egusi soup." });
    expect(confirmed).toMatchObject({ ok: true, draft: { state: "confirmed" } });
    expect((await storeScoped(storeId).listing.findUniqueOrThrow({ where: { id: ids.noDescription! } })).description)
      .toBe("Ground egusi melon seeds from Nigeria. For egusi soup.");
    expect(await storeScoped(storeId).auditLog.count({ where: { action: "listing.description_change", entityId: ids.noDescription } })).toBe(1);
  });

  it("a description with a health claim, a price, stock words or a number not in the facts is refused; the listing is unchanged", async () => {
    const sent = await send("Write a description for Egusi 1 lb", [
      { kind: "tool", toolName: "listing_facts", toolInput: { query: "egusi" } },
      { kind: "tool", toolName: "draft_description", toolInput: { listingId: ids.noDescription, text: "Egusi seeds that boost immunity." } },
      { kind: "tool", toolName: "draft_description", toolInput: { listingId: ids.noDescription, text: "Egusi seeds, only $6.99." } },
      { kind: "tool", toolName: "draft_description", toolInput: { listingId: ids.noDescription, text: "Egusi seeds, in stock now." } },
      { kind: "tool", toolName: "draft_description", toolInput: { listingId: ids.noDescription, text: "Egusi seeds, 5 lb bag." } },
      { kind: "text", text: "I could not draft that." },
    ]);
    expect(sent.drafts).toHaveLength(0);
  });

  it("a description for a listing whose facts were not read this turn is refused", async () => {
    const sent = await send("Write a description for Complete thing", [
      { kind: "tool", toolName: "draft_description", toolInput: { listingId: ids.complete, text: "A complete thing." } },
      { kind: "text", text: "I could not draft that." },
    ]);
    expect(sent.drafts).toHaveLength(0);
  });

  it("a description changed since the draft asks again instead of overwriting it", async () => {
    const sent = await send("Write a description for Complete thing", [
      { kind: "tool", toolName: "listing_facts", toolInput: { query: "complete thing" } },
      { kind: "tool", toolName: "draft_description", toolInput: { listingId: ids.complete, text: "A complete thing for the kitchen." } },
      { kind: "text", text: "Drafted." },
    ]);
    const card = sent.drafts[0]!;
    await storeScoped(storeId).listing.update({ where: { id: ids.complete! }, data: { description: "Owner's own words." } });
    expect(await confirmCopilotDraft({ draftId: card.id })).toMatchObject({ ok: false, code: "stale" });
    expect((await storeScoped(storeId).listing.findUniqueOrThrow({ where: { id: ids.complete! } })).description).toBe("Owner's own words.");
  });
});
