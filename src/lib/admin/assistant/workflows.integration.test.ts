import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.AUTH_RATE_LIMIT_RELAXED = "1";
});

const { headerState } = vi.hoisted(() => ({ headerState: new Headers() }));

vi.mock("next/headers", () => ({ headers: async () => headerState }));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (fn: () => unknown) => () => fn() }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

import { auth } from "../../auth";
import { fakeAddressBackend, setAddressProvider } from "../../address/provider";
import { authPrisma, platformAdmin, platformAdminTransaction } from "../../db";
import { testSignUp } from "../../test-auth";
import { testPrismaClient } from "../../test-prisma";
import { confirmAdminAssistantDraft } from "./actions";
import { insertAdminDrafts, type AdminDraftCard } from "./drafts";
import { adminAssistantTools, createReadBook } from "./tools";

const RUN = `t833-${Date.now()}`;
const hasDb = !!process.env.DATABASE_URL;
const password = "Assistant-833-Admin!";

type FakeSession = Awaited<ReturnType<typeof auth.api.getSession>>;

function signInAs(user: { id: string; email: string }): void {
  vi.spyOn(auth.api, "getSession").mockResolvedValue({
    user: { id: user.id, email: user.email, role: "platform_admin", twoFactorEnabled: true },
    session: { twoFactorVerified: true },
  } as unknown as FakeSession);
}

const sql = <T>(fn: Parameters<typeof platformAdminTransaction<T>>[0]) => platformAdminTransaction(fn);

describe.skipIf(!hasDb)("platform admin assistant workflows at the tool and confirm seam (#833)", () => {
  const admin = { id: "", email: `admin-${RUN}@example.com` };
  const metroId = crypto.randomUUID();
  const metroName = `Houston ${RUN}`;
  const slugs: string[] = [];
  let conversationId = "";
  const owner = testPrismaClient();

  async function draft(name: string, input: Record<string, unknown>): Promise<{ result: Record<string, unknown>; cards: AdminDraftCard[] }> {
    const book = createReadBook();
    const tools = adminAssistantTools({ actor: admin, conversationId, book, now: new Date() }) as unknown as Record<string, { execute?: (input: unknown, opts: unknown) => Promise<unknown> }>;
    const result = (await tools[name]!.execute!(input, { toolCallId: "t", messages: [] })) as Record<string, unknown>;
    const cards = await sql((tx) => insertAdminDrafts(tx, { userId: admin.id, email: admin.email, conversationId, messageId: crypto.randomUUID() }, book.drafts));
    return { result, cards };
  }

  const auditActions = (entityId: string) =>
    platformAdmin.auditLog.findMany({ where: { entityId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] }).then((rows) => rows.map((row) => row.action));

  const storeInput = (slug: string) => ({
    name: `Ade's Market ${RUN}`,
    slug,
    addressLine1: "3700 Main St",
    city: "Houston",
    state: "TX",
    zip: "77002",
    ownerEmail: `ade-${RUN}@example.com`,
    metro: metroName,
  });

  beforeAll(async () => {
    vi.stubEnv("PLATFORM_ROOT_DOMAIN", "");
    setAddressProvider(fakeAddressBackend());
    const res = await testSignUp({ email: admin.email, password, name: "Admin" });
    expect(res.status, await res.clone().text()).toBe(200);
    admin.id = (await authPrisma.user.findFirstOrThrow({ where: { email: admin.email } })).id;
    conversationId = crypto.randomUUID();
    await owner.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await tx.adminAssistantConversation.create({ data: { id: conversationId, userId: admin.id, model: "test" } });
      await tx.metro.create({ data: { id: metroId, name: metroName, states: ["TX"], centerLat: 29.76, centerLng: -95.37, radiusMi: 40 } });
    });
  }, 60_000);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    setAddressProvider(null);
    await owner.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await tx.adminAssistantConversation.deleteMany({ where: { userId: admin.id } });
      const stores = await tx.store.findMany({ where: { slug: { in: slugs } }, select: { id: true } });
      for (const { id } of stores) {
        await tx.$executeRaw`DELETE FROM store_invites WHERE store_id = ${id}`;
        await tx.$executeRaw`DELETE FROM store_subscriptions WHERE store_id = ${id}`;
        await tx.$executeRaw`DELETE FROM audit_logs WHERE store_id = ${id}`;
        await tx.$executeRaw`DELETE FROM stores WHERE id = ${id}`;
      }
      await tx.metro.deleteMany({ where: { id: metroId } });
    });
    await owner.$disconnect();
  });

  describe("store creation", () => {
    it("asks for what is missing instead of drafting", async () => {
      signInAs(admin);
      const { result, cards } = await draft("draft_store_create", { name: `Ade's Market ${RUN}`, city: "Houston" });
      expect(cards).toEqual([]);
      expect(result).toMatchObject({ drafted: false });
      expect(result.missing).toEqual(expect.arrayContaining(["slug", "street address", "state", "ZIP", "owner email", "metro"]));
    });

    it("refuses a slug another store has", async () => {
      signInAs(admin);
      const slug = `ade-taken-${RUN}`;
      slugs.push(slug);
      await sql((tx) => tx.$executeRaw`INSERT INTO stores (id, name, slug, status, updated_at) VALUES (${crypto.randomUUID()}, 'Taken', ${slug}, 'setup', now())`);
      const { result, cards } = await draft("draft_store_create", storeInput(slug));
      expect(cards).toEqual([]);
      expect(result).toMatchObject({ drafted: false, reason: expect.stringContaining("slug") });
    });

    it("shows every step on one card and runs them in order on confirm", async () => {
      signInAs(admin);
      const slug = `ade-${RUN}`;
      slugs.push(slug);
      const { cards } = await draft("draft_store_create", storeInput(slug));
      expect(cards).toHaveLength(1);
      expect(cards[0]!.steps).toEqual(["Create the store", `Put it in the ${metroName} metro`, `Invite the owner, ade-${RUN}@example.com`]);
      expect(await platformAdmin.store.findUnique({ where: { slug } })).toBeNull();

      const confirmed = await confirmAdminAssistantDraft({ draftId: cards[0]!.id });
      expect(confirmed).toMatchObject({ ok: true, draft: { state: "confirmed" } });
      const store = await platformAdmin.store.findUniqueOrThrow({ where: { slug } });
      expect(store).toMatchObject({ name: `Ade's Market ${RUN}`, status: "setup", city: "Houston", state: "TX", metroId });
      expect(await platformAdmin.storeInvite.count({ where: { storeId: store.id, email: `ade-${RUN}@example.com`, role: "owner" } })).toBe(1);
      expect(await auditActions(cards[0]!.id)).toEqual(["admin_assistant.draft_proposed", "admin_assistant.draft_confirmed"]);
    });

    it("says which step failed and what was already done", async () => {
      signInAs(admin);
      const slug = `ade-fail-${RUN}`;
      slugs.push(slug);
      const goneMetro = crypto.randomUUID();
      await sql((tx) => tx.metro.create({ data: { id: goneMetro, name: `Gone ${RUN}`, states: ["TX"], centerLat: 29.7, centerLng: -95.3, radiusMi: 30 } }));
      const { cards } = await draft("draft_store_create", { ...storeInput(slug), metro: `Gone ${RUN}` });
      await sql((tx) => tx.metro.delete({ where: { id: goneMetro } }));

      const result = await confirmAdminAssistantDraft({ draftId: cards[0]!.id });
      expect(result).toMatchObject({ ok: true, draft: { state: "confirmed" } });
      const outcome = (result as { draft: AdminDraftCard }).draft.outcome!;
      expect(outcome).toContain("Step 2");
      expect(outcome).toContain("Done: the store was created");
      const store = await platformAdmin.store.findUniqueOrThrow({ where: { slug } });
      expect(store.metroId).toBeNull();
      expect(await platformAdmin.storeInvite.count({ where: { storeId: store.id } })).toBe(0);
    });
  });
});
