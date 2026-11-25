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
import { getRecipeEditor, listRecipeBase } from "../recipe-base-admin";
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
  const cat = { parent: "", child: "" };
  const product = { clean1: "", clean2: "", noPhoto: "", dupA: "", dupB: "" };
  let pairId = "";
  let proposalId = "";
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
      cat.parent = (await tx.category.create({ data: { name: `Grains ${RUN}`, slug: `grains-${RUN}`, sortOrder: 900 } })).id;
      cat.child = (await tx.category.create({ data: { name: `Rice ${RUN}`, slug: `rice-${RUN}`, sortOrder: 901 } })).id;
      const make = (name: string, data: Record<string, unknown> = {}) => tx.masterProduct.create({
        data: { name: `${name} ${RUN}`, categoryId: cat.child, status: "needs_review", description: `${name}, 5 lb bag.`, unit: "5 lb", confidence: "high", imageUrl: "https://example.com/p.webp", ...data },
      }).then((row) => row.id);
      product.clean1 = await make("Ofada rice");
      product.clean2 = await make("Jollof rice mix");
      product.noPhoto = await make("Basmati rice", { imageUrl: null });
      const [a, b] = [await make("Garri white", { status: "active" }), await make("White garri", { status: "active" })].sort();
      product.dupA = a!;
      product.dupB = b!;
      proposalId = (await tx.attributeProposal.create({
        data: { productId: product.clean1, ingredientsRead: true, ingredients: ["rice"], allergensRead: true, allergens: [], dietaryRead: false },
      })).id;
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
      const ids = Object.values(product);
      await tx.masterProduct.updateMany({ where: { id: { in: ids } }, data: { mergedIntoId: null, status: "archived" } });
      await tx.$executeRaw`DELETE FROM master_product_ingredients WHERE product_id = ANY(${ids})`;
      await tx.masterProduct.deleteMany({ where: { id: { in: ids } } });
      await tx.masterProduct.deleteMany({ where: { name: { contains: RUN } } });
      await tx.recipe.deleteMany({ where: { name: { contains: RUN } } });
      await tx.category.deleteMany({ where: { name: { contains: RUN }, parentId: { not: null } } });
      await tx.category.deleteMany({ where: { name: { contains: RUN } } });
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

  describe("batches", () => {
    it("lists each product in the review queue with its problems, and approves only the ones left ticked", async () => {
      signInAs(admin);
      const ids = [product.clean1, product.clean2, product.noPhoto];
      const all = await draft("draft_review_approve", { onlyClean: false, productIds: ids });
      expect(all.cards[0]!.items).toEqual(expect.arrayContaining([
        { key: product.noPhoto, label: `Basmati rice ${RUN}`, problems: ["no photo"] },
        { key: product.clean1, label: `Ofada rice ${RUN}`, problems: [] },
      ]));

      const { cards } = await draft("draft_review_approve", { productIds: ids });
      expect(cards).toHaveLength(1);
      expect(cards[0]!.items!.map((item) => item.key).sort()).toEqual([product.clean1, product.clean2].sort());

      const result = await confirmAdminAssistantDraft({ draftId: cards[0]!.id, keep: [product.clean1] });
      expect(result).toMatchObject({ ok: true, draft: { state: "confirmed" } });
      const statuses = await platformAdmin.masterProduct.findMany({ where: { id: { in: ids } }, select: { id: true, status: true } });
      expect(Object.fromEntries(statuses.map((row) => [row.id, row.status]))).toEqual({
        [product.clean1]: "active", [product.clean2]: "needs_review", [product.noPhoto]: "needs_review",
      });
      expect(await platformAdmin.auditLog.count({ where: { entityId: product.clean1, action: "catalog.approve", actorId: admin.id } })).toBe(1);
    });

    it("refuses a confirm with every item unticked", async () => {
      signInAs(admin);
      const { cards } = await draft("draft_review_approve", { productIds: [product.clean2] });
      expect(await confirmAdminAssistantDraft({ draftId: cards[0]!.id, keep: [] })).toMatchObject({ ok: false, code: "invalid" });
      expect((await platformAdmin.masterProduct.findUniqueOrThrow({ where: { id: product.clean2 } })).status).toBe("needs_review");
    });

    it("approves attribute proposals through the review screen's function", async () => {
      signInAs(admin);
      const { cards } = await draft("draft_attribute_approve", { productIds: [product.clean1] });
      expect(cards[0]!.items).toEqual([{ key: proposalId, label: `Ofada rice ${RUN}`, problems: [] }]);
      expect(await confirmAdminAssistantDraft({ draftId: cards[0]!.id })).toMatchObject({ ok: true });
      expect((await platformAdmin.attributeProposal.findUniqueOrThrow({ where: { id: proposalId } })).status).toBe("approved");
    });

    it("adds synonyms, and reports the one the product already has", async () => {
      signInAs(admin);
      const { cards } = await draft("draft_synonyms", { synonyms: [
        { product: `Ofada rice ${RUN}`, term: "ofada", language: "yo" },
        { product: `Ofada rice ${RUN}`, term: "local rice" },
      ] });
      expect(cards[0]!.items!.map((item) => item.label)).toEqual([`"ofada" in Yoruba (yo) for Ofada rice ${RUN}`, `"local rice" for Ofada rice ${RUN}`]);
      await sql((tx) => tx.productSynonym.create({ data: { productId: product.clean1, term: "local rice" } }));
      const result = await confirmAdminAssistantDraft({ draftId: cards[0]!.id });
      expect(result).toMatchObject({ ok: true, draft: { outcome: expect.stringContaining("local rice") } });
      expect(await platformAdmin.productSynonym.count({ where: { productId: product.clean1, term: "ofada", language: "yo" } })).toBe(1);
    });

    it("merges a duplicate pair into the product the admin keeps", async () => {
      signInAs(admin);
      // Made here, not in beforeAll: a duplicate scan in another test file replaces the open pairs, or finds this one.
      pairId = (await sql((tx) => tx.catalogDuplicatePair.upsert({
        where: { productAId_productBId: { productAId: product.dupA, productBId: product.dupB } },
        create: { productAId: product.dupA, productBId: product.dupB, nameSimilarity: 0.8, sharedTerms: 1, score: 0.9, verdict: "same" },
        update: { status: "open", verdict: "same" },
      }))).id;
      const { cards } = await draft("draft_duplicate_merge", { merges: [{ pairId, keepProductId: product.dupA }] });
      expect(cards[0]!.items).toEqual([{ key: pairId, label: `Keep Garri white ${RUN}, merge White garri ${RUN} into it`, problems: [] }]);
      expect(await confirmAdminAssistantDraft({ draftId: cards[0]!.id })).toMatchObject({ ok: true });
      expect(await platformAdmin.masterProduct.findUniqueOrThrow({ where: { id: product.dupB } })).toMatchObject({ status: "merged", mergedIntoId: product.dupA });
    });

    it("creates, renames and moves categories", async () => {
      signInAs(admin);
      const { cards } = await draft("draft_category_changes", { changes: [
        { action: "create", name: `Flours ${RUN}`, parent: `Grains ${RUN}` },
        { action: "rename", category: `Rice ${RUN}`, name: `Rice and grains ${RUN}` },
        { action: "move", category: `Rice ${RUN}`, parent: `Grains ${RUN}` },
      ] });
      expect(cards[0]!.items).toHaveLength(3);
      expect(await confirmAdminAssistantDraft({ draftId: cards[0]!.id })).toMatchObject({ ok: true });
      const child = await platformAdmin.category.findUniqueOrThrow({ where: { id: cat.child } });
      expect(child).toMatchObject({ name: `Rice and grains ${RUN}`, parentId: cat.parent });
      expect(await platformAdmin.category.findFirst({ where: { name: `Flours ${RUN}`, parentId: cat.parent } })).not.toBeNull();
    });
  });

  describe("catalogue products", () => {
    it("offers the existing product instead of drafting a duplicate", async () => {
      signInAs(admin);
      const { result, cards } = await draft("draft_product", { name: `Ofada rice ${RUN}`, category: `Rice ${RUN}`, size: "5 lb" });
      expect(cards).toEqual([]);
      expect(result).toMatchObject({ drafted: false, existing: expect.arrayContaining([expect.objectContaining({ id: product.clean1, name: `Ofada rice ${RUN}` })]) });
    });

    it("refuses a description with a health claim, a price or an origin the product data does not give", async () => {
      signInAs(admin);
      for (const description of ["Egusi seeds that boost your immune system.", "Egusi seeds, only $4.99 a bag.", "Egusi seeds grown in Ghana."]) {
        const { result, cards } = await draft("draft_product", { name: `Egusi seeds ${RUN}`, category: `Grains ${RUN}`, size: "1 lb", description, notDuplicate: true });
        expect(cards, description).toEqual([]);
        expect(result, description).toMatchObject({ drafted: false, reason: expect.stringContaining("The description has") });
      }
    });

    it("creates a product with its synonyms on confirm, and sends an attached photo through the photo upload", async () => {
      signInAs(admin);
      const name = `Egusi seeds ${RUN}`;
      const { cards } = await draft("draft_product", {
        name, category: `Grains ${RUN}`, size: "1 lb", description: "Ground melon seeds for egusi soup.", synonyms: [{ term: "agusi", language: "tw" }], notDuplicate: true,
      });
      expect(cards[0]).toMatchObject({ title: "Create a catalogue product", acceptsPhoto: true });
      expect(cards[0]!.steps).toEqual(["Save the product", "Add 1 synonym", "Upload the photo, if you attach one"]);

      const data = new FormData();
      data.set("draftId", cards[0]!.id);
      data.set("image", new File([new Uint8Array([1, 2, 3])], "egusi.jpg", { type: "image/jpeg" }));
      const result = await confirmAdminAssistantDraft(data);
      expect(result).toMatchObject({ ok: true, draft: { state: "confirmed" } });
      const created = await platformAdmin.masterProduct.findFirstOrThrow({ where: { name }, include: { synonyms: true } });
      expect(created).toMatchObject({ categoryId: cat.parent, unit: "1 lb", description: "Ground melon seeds for egusi soup.", status: "active" });
      expect(created.synonyms.map((row) => row.term)).toEqual(["agusi"]);
      // No photo storage in tests: the upload's own refusal shows that the photo went through it.
      expect((result as { draft: AdminDraftCard }).draft.outcome).toMatch(/Step 3 did not run: (Upload a JPEG|Photo storage)/);
      expect(await platformAdmin.auditLog.count({ where: { entityId: created.id, action: "catalog.product_create", actorId: admin.id } })).toBe(1);
    });

    it("edits a product, and goes stale when someone else saved it first", async () => {
      signInAs(admin);
      const { cards } = await draft("draft_product", { productId: product.clean2, description: "A seasoning mix for jollof rice." });
      expect(cards[0]!.changes).toContainEqual({ field: "Description", from: "Jollof rice mix, 5 lb bag.", to: "A seasoning mix for jollof rice." });
      const stale = await draft("draft_product", { productId: product.clean2, size: "2 lb" });
      expect(await confirmAdminAssistantDraft({ draftId: cards[0]!.id })).toMatchObject({ ok: true });
      expect((await platformAdmin.masterProduct.findUniqueOrThrow({ where: { id: product.clean2 } })).description).toBe("A seasoning mix for jollof rice.");
      expect(await confirmAdminAssistantDraft({ draftId: stale.cards[0]!.id })).toMatchObject({ ok: false, code: "stale" });
    });
  });

  describe("recipes", () => {
    it("drafts a recipe into the recipe base, not curated until the admin marks it", async () => {
      signInAs(admin);
      const name = `Ofada stew ${RUN}`;
      const { cards } = await draft("draft_recipe", {
        name, servings: 4, ingredients: [{ name: "Ofada rice", product: `Ofada rice ${RUN}`, qty: "2", unit: "cup" }, { name: "Palm oil", qty: "0.5", unit: "cup" }],
      });
      expect(cards[0]!.title).toBe("Add a recipe");
      expect(await confirmAdminAssistantDraft({ draftId: cards[0]!.id })).toMatchObject({ ok: true });
      const { recipes } = await listRecipeBase({ q: name });
      const saved = recipes.find((row) => row.name === name)!;
      expect(saved.origin).not.toBe("curated");
      const editor = await getRecipeEditor(saved.id);
      expect(editor!.recipe.ingredients.map((row) => [row.name, row.masterProductId, row.qty])).toEqual([["Ofada rice", product.clean1, "2"], ["Palm oil", null, "0.5"]]);
    });
  });
});
