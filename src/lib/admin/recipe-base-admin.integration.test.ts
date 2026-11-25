import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { generateTOTP } from "../../../e2e/totp";

vi.hoisted(() => {
  process.env.AUTH_RATE_LIMIT_RELAXED = "1";
});

const { headerState } = vi.hoisted(() => ({ headerState: new Headers() }));

vi.mock("next/headers", () => ({
  headers: async () => headerState,
}));

vi.mock("next/cache", () => ({
  unstable_cache: (fn: () => unknown) => fn,
  revalidateTag: () => {},
  revalidatePath: () => {},
}));

vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`REDIRECT:${path}`);
  },
}));

import { deleteRecipe, getRecipeEditor, listRecipeBase, markRecipeCurated, saveRecipe } from "./recipe-base-admin";
import { authPrisma, storeScoped } from "../db";
import { createFakeAnthropicFetch } from "../assistant/messages-api-double";
import { createAssistantModel } from "../assistant/model";
import { findRecipe, saveLookedUpRecipe } from "../assistant/recipes";
import { getRecipe } from "../assistant/tools/recipe";
import { authPost, testSignUp, collectCookies } from "../test-auth";

const RUN = `rb${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const password = "GuardPass-123!";
const adminEmail = `${RUN}-admin@test.example`;
const ownerEmail = `${RUN}-owner@test.example`;

async function signUp(email: string): Promise<string> {
  const res = await testSignUp({ email, password, name: RUN });
  expect(res.status, await res.clone().text()).toBe(200);
  return (await authPrisma.user.findFirstOrThrow({ where: { email } })).id;
}

/** Signs in with a verified TOTP second factor and returns the session cookies. */
async function signInWith2fa(email: string): Promise<string> {
  const signedIn = await authPost("/sign-in/email", { email, password });
  expect(signedIn.status, await signedIn.clone().text()).toBe(200);
  const cookies = collectCookies(signedIn);
  const enabled = await authPost("/two-factor/enable", { password }, cookies);
  expect(enabled.status, await enabled.clone().text()).toBe(200);
  const secret = new URL(((await enabled.json()) as { totpURI: string }).totpURI).searchParams.get("secret");
  if (!secret) throw new Error("TOTP URI has no secret");
  const verified = await authPost("/two-factor/verify-totp", { code: generateTOTP(secret) }, cookies);
  expect(verified.status, await verified.clone().text()).toBe(200);
  return collectCookies(verified) || cookies;
}

async function asPlatformAdmin<T>(fn: (tx: Parameters<Parameters<typeof authPrisma.$transaction>[0]>[0]) => Promise<T>): Promise<T> {
  return authPrisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL ROLE app_user`;
    await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
    return fn(tx);
  });
}

describe("recipe base admin (real sessions, lane DB)", () => {
  let adminId = "";
  let ownerId = "";
  let adminCookies = "";
  let ownerCookies = "";
  const productIds = { rice: `${RUN}-rice`, pepper: `${RUN}-pepper`, archived: `${RUN}-archived` };
  // Every dish of this file is named after RUN, so no other file's rows answer to them.
  const recipes: Record<string, string> = {};

  async function makeRecipe(label: string, data: { origin: string; aliases?: string[]; servings?: number | null; sourceUrl?: string | null }) {
    const name = `${RUN} ${label}`;
    const key = name.toLowerCase();
    recipes[label] = await asPlatformAdmin(async (tx) => (await tx.recipe.create({
      data: {
        key,
        name,
        aliases: data.aliases ?? [],
        servings: data.servings ?? null,
        sourceUrl: data.sourceUrl ?? null,
        origin: data.origin,
        ingredients: { create: [{ position: 0, name: "rice", masterProductId: data.origin === "curated" ? productIds.rice : null, qty: data.origin === "curated" ? 2 : null, unit: data.origin === "curated" ? "cup" : null }] },
      },
    })).id);
  }

  beforeAll(async () => {
    adminId = await signUp(adminEmail);
    ownerId = await signUp(ownerEmail);
    await authPrisma.user.update({ where: { id: adminId }, data: { role: "platform_admin" } });
    adminCookies = await signInWith2fa(adminEmail);
    ownerCookies = await signInWith2fa(ownerEmail);
    await asPlatformAdmin(async (tx) => {
      await tx.masterProduct.create({ data: { id: productIds.rice, name: `${RUN} Rice`, status: "active" } });
      await tx.masterProduct.create({ data: { id: productIds.pepper, name: `${RUN} Pepper`, status: "active" } });
      await tx.masterProduct.create({ data: { id: productIds.archived, name: `${RUN} Old stock`, status: "archived" } });
    });
    await makeRecipe("jollof", { origin: "curated", aliases: [`${RUN} party rice`], servings: 4 });
    await makeRecipe("kelewele", { origin: "lookup", sourceUrl: "https://recipes.example/kelewele" });
    await makeRecipe("suya", { origin: "lookup", sourceUrl: "https://recipes.example/suya" });
    await makeRecipe("waakye", { origin: "lookup", sourceUrl: "javascript:alert(1)" });
  }, 90_000);

  afterAll(async () => {
    await asPlatformAdmin(async (tx) => {
      await tx.$executeRaw`DELETE FROM audit_logs WHERE actor_id IN (${adminId}, ${ownerId})`;
      await tx.$executeRaw`DELETE FROM recipes WHERE key LIKE ${`${RUN}%`}`;
      await tx.masterProduct.deleteMany({ where: { id: { in: Object.values(productIds) } } });
      for (const userId of [adminId, ownerId]) {
        await tx.$executeRaw`DELETE FROM two_factors WHERE user_id = ${userId}`;
        await tx.$executeRaw`DELETE FROM sessions WHERE user_id = ${userId}`;
        await tx.$executeRaw`DELETE FROM accounts WHERE user_id = ${userId}`;
        await tx.$executeRaw`DELETE FROM users WHERE id = ${userId}`;
      }
    });
  });

  beforeEach(() => {
    headerState.set("cookie", adminCookies);
  });

  const readRecipe = (id: string) => asPlatformAdmin((tx) =>
    tx.recipe.findUnique({ where: { id }, include: { ingredients: { orderBy: { position: "asc" } } } }));
  const audits = (id: string, action: string) =>
    asPlatformAdmin((tx) => tx.auditLog.findMany({ where: { entityId: id, action }, orderBy: { createdAt: "asc" } }));

  /** Every page of the list for a filter, so dishes other files add cannot push this file's off the first page. */
  async function allRows(filters: { origin?: "curated" | "lookup" } = {}) {
    const rows = [];
    for (let page = 1; ; page += 1) {
      const result = await listRecipeBase({ ...filters, page, pageSize: 100 });
      rows.push(...result.recipes);
      if (page * result.pageSize >= result.total) return rows;
    }
  }

  describe("list", () => {
    it("filters curated and looked-up dishes and shows each source URL", async () => {
      const curated = (await allRows({ origin: "curated" })).map((row) => row.id);
      const lookup = await allRows({ origin: "lookup" });
      expect(curated).toContain(recipes.jollof);
      expect(curated).not.toContain(recipes.kelewele);
      expect(lookup.map((row) => row.id)).toEqual(expect.arrayContaining([recipes.kelewele, recipes.suya]));
      expect(lookup.map((row) => row.id)).not.toContain(recipes.jollof);
      expect(lookup.find((row) => row.id === recipes.kelewele)).toMatchObject({
        origin: "lookup", sourceUrl: "https://recipes.example/kelewele", ingredientCount: 1, mappedCount: 0,
      });
      // A stored link that is not http(s) is never handed to the page as a link.
      expect(lookup.find((row) => row.id === recipes.waakye)?.sourceUrl).toBeNull();
    });

    it("finds a dish by its exact folded name or other name, never by a pattern", async () => {
      expect((await listRecipeBase({ q: `${RUN} JOLLOF!` })).recipes.map((row) => row.id)).toEqual([recipes.jollof]);
      expect((await listRecipeBase({ q: `${RUN} party rice` })).recipes.map((row) => row.id)).toEqual([recipes.jollof]);
      expect((await listRecipeBase({ q: `${RUN}%` })).recipes).toEqual([]);
    });

    it("is refused to a signed-in user who is not a platform admin, and to a guest", async () => {
      headerState.set("cookie", ownerCookies);
      await expect(listRecipeBase({})).rejects.toThrow("REDIRECT:/admin/sign-in");
      headerState.delete("cookie");
      await expect(listRecipeBase({})).rejects.toThrow("REDIRECT:/admin/sign-in");
    });
  });

  function editorForm(recipeId: string, version: string | undefined, fields: {
    name?: string;
    aliases?: string;
    servings?: string;
    ingredients?: Array<{ name: string; product?: string; qty?: string; unit?: string }>;
  } = {}): FormData {
    const form = new FormData();
    form.set("recipeId", recipeId);
    if (version) form.set("version", version);
    form.set("name", fields.name ?? `${RUN} suya`);
    form.set("aliases", fields.aliases ?? "");
    form.set("servings", fields.servings ?? "");
    for (const row of fields.ingredients ?? [{ name: "rice" }]) {
      form.append("ingredientName", row.name);
      form.append("ingredientProduct", row.product ?? "");
      form.append("ingredientQty", row.qty ?? "");
      form.append("ingredientUnit", row.unit ?? "");
    }
    return form;
  }

  const versionOf = async (id: string) => (await getRecipeEditor(id))?.recipe.version;

  describe("editor", () => {
    it("loads the dish with its rows and the products it can map to, archived ones left out", async () => {
      const editor = await getRecipeEditor(recipes.jollof);
      expect(editor?.recipe).toMatchObject({ name: `${RUN} jollof`, key: `${RUN} jollof`, aliases: [`${RUN} party rice`], servings: 4, origin: "curated" });
      expect(editor?.recipe.ingredients).toEqual([{ name: "rice", masterProductId: productIds.rice, masterProductName: `${RUN} Rice`, qty: "2", unit: "cup" }]);
      const ids = editor?.products.map((row) => row.id);
      expect(ids).toEqual(expect.arrayContaining([productIds.rice, productIds.pepper]));
      expect(ids).not.toContain(productIds.archived);
      expect(await getRecipeEditor("no-such-recipe")).toBeNull();
      headerState.set("cookie", ownerCookies);
      await expect(getRecipeEditor(recipes.jollof)).rejects.toThrow("REDIRECT:/admin/sign-in");
    });

    it("saves name, other names, servings and every ingredient row, moves the key with the name, and audits before and after", async () => {
      const id = recipes.suya;
      const saved = await saveRecipe({}, editorForm(id, await versionOf(id), {
        name: `${RUN} Suya spice`,
        aliases: `${RUN} yaji\n\n${RUN} YAJI\n${RUN} suya spice`,
        servings: "6",
        ingredients: [
          { name: "Ground peanuts", product: productIds.rice, qty: "1.5", unit: "cup" },
          { name: "Cayenne pepper", product: productIds.pepper, qty: "2", unit: "tsp" },
          { name: "Ginger" },
        ],
      }));
      expect(saved).toMatchObject({ ok: true, message: "Saved" });

      const row = await readRecipe(id);
      expect(row).toMatchObject({ key: `${RUN} suya spice`, name: `${RUN} Suya spice`, aliases: [`${RUN} yaji`, `${RUN} suya`], servings: 6, origin: "lookup" });
      expect(row?.ingredients.map((item) => [item.position, item.name, item.masterProductId, item.qty?.toString() ?? null, item.unit])).toEqual([
        [0, "Ground peanuts", productIds.rice, "1.5", "cup"],
        [1, "Cayenne pepper", productIds.pepper, "2", "tsp"],
        [2, "Ginger", null, null, null],
      ]);
      // The shopper assistant answers to the new name, the other name, and the old name it answered to before.
      expect((await findRecipe(`${RUN} yaji`))?.name).toBe(`${RUN} Suya spice`);
      expect((await findRecipe(`${RUN} suya`))?.name).toBe(`${RUN} Suya spice`);

      const logged = await audits(id, "catalog.recipe_edit");
      expect(logged).toHaveLength(1);
      expect(logged[0]).toMatchObject({ actorId: adminId, actorEmail: adminEmail, entityType: "recipe" });
      expect(logged[0].before).toMatchObject({ key: `${RUN} suya`, name: `${RUN} suya`, aliases: [], servings: null, ingredients: [{ name: "rice", masterProductId: null, qty: null, unit: null }] });
      expect(logged[0].after).toMatchObject({ key: `${RUN} suya spice`, name: `${RUN} Suya spice`, aliases: [`${RUN} yaji`, `${RUN} suya`], servings: 6 });
    });

    it("keeps the term a looked-up dish was asked for through a save, a quantity fix and a rename", async () => {
      // A lookup stores the shopper's term as the key and the model's name beside it, so the key is not the folded name.
      const asked = `${RUN} ofada`;
      const saved = await saveLookedUpRecipe(asked, { name: `${RUN} Ofada Stew (Nigerian)`, ingredients: ["rice"], sourceUrl: "https://x.example/ofada" });
      const id = (await asPlatformAdmin((tx) => tx.recipe.findUniqueOrThrow({ where: { key: asked }, select: { id: true } }))).id;
      recipes.ofada = id;
      const form = async (fields: Parameters<typeof editorForm>[2]) => {
        const ed = (await getRecipeEditor(id))!;
        return editorForm(id, ed.recipe.version, { name: ed.recipe.name, aliases: ed.recipe.aliases.join("\n"), ingredients: [{ name: "rice" }], ...fields });
      };
      expect(saved.name).toBe(`${RUN} Ofada Stew (Nigerian)`);

      expect(await saveRecipe({}, await form({}))).toMatchObject({ ok: true, message: "No changes to save" });
      expect((await findRecipe(asked))?.name).toBe(`${RUN} Ofada Stew (Nigerian)`);

      expect(await saveRecipe({}, await form({ servings: "4", ingredients: [{ name: "rice", qty: "2", unit: "cup" }] }))).toMatchObject({ ok: true, message: "Saved" });
      expect((await findRecipe(asked))?.servings).toBe(4);
      expect((await findRecipe(`${RUN} ofada stew nigerian`))?.servings).toBe(4);

      expect(await saveRecipe({}, await form({ name: `${RUN} Ofada sauce`, servings: "4", ingredients: [{ name: "rice", qty: "2", unit: "cup" }] }))).toMatchObject({ ok: true, message: "Saved" });
      for (const term of [asked, `${RUN} ofada stew nigerian`, `${RUN} ofada sauce`]) {
        expect((await findRecipe(term))?.name, term).toBe(`${RUN} Ofada sauce`);
      }
      const logged = await audits(id, "catalog.recipe_edit");
      expect(logged.map((row) => [(row.before as { key: string }).key, (row.after as { key: string }).key])).toEqual([
        [asked, asked],
        [asked, `${RUN} ofada sauce`],
      ]);
    });

    it("refuses a name or other name another dish already answers to, by its name or its other names", async () => {
      const id = recipes.kelewele;
      const before = await readRecipe(id);
      const version = await versionOf(id);
      const keyTaken = await saveRecipe({}, editorForm(id, version, { name: `${RUN} Jollof` }));
      expect(keyTaken.fieldErrors?.name).toBe(`${RUN} jollof already answers to this name`);
      const nameIsAlias = await saveRecipe({}, editorForm(id, version, { name: `${RUN} party rice` }));
      expect(nameIsAlias.fieldErrors?.name).toBe(`${RUN} jollof already answers to this name`);
      const aliasIsKey = await saveRecipe({}, editorForm(id, version, { name: `${RUN} kelewele`, aliases: `${RUN} jollof` }));
      expect(aliasIsKey.fieldErrors?.aliases).toBe(`“${RUN} jollof” already answers to ${RUN} jollof`);
      const aliasIsAlias = await saveRecipe({}, editorForm(id, version, { name: `${RUN} kelewele`, aliases: `${RUN} Party-Rice` }));
      expect(aliasIsAlias.fieldErrors?.aliases).toBe(`“${RUN} party rice” already answers to ${RUN} jollof`);
      expect(await readRecipe(id)).toEqual(before);
      expect(await audits(id, "catalog.recipe_edit")).toHaveLength(0);
    });

    it("refuses a name with no letter or digit, writing nothing", async () => {
      const id = recipes.suya;
      const before = await readRecipe(id);
      const auditsBefore = await audits(id, "catalog.recipe_edit");
      const result = await saveRecipe({}, editorForm(id, await versionOf(id), { name: "!!! ???" }));
      expect(result.fieldErrors?.name).toBe("The name needs a letter or a digit");
      expect(await readRecipe(id)).toEqual(before);
      expect(await audits(id, "catalog.recipe_edit")).toEqual(auditsBefore);
    });

    it("refuses a rename to a name a shopper's lookup saved after the name check, as a field error", async () => {
      await makeRecipe("kenkey", { origin: "lookup" });
      const id = recipes.kenkey;
      const version = await versionOf(id);
      const name = `${RUN} Fanti kenkey`;
      // The lookup's insert is in flight, uncommitted, when the admin saves: the name check cannot see it yet.
      let inserted = false;
      let commit = () => {};
      const lookup = asPlatformAdmin(async (tx) => {
        await tx.recipe.create({ data: { key: name.toLowerCase(), name, aliases: [], origin: "lookup", ingredients: { create: [{ position: 0, name: "corn" }] } } });
        await new Promise<void>((resolve) => { commit = resolve; inserted = true; });
      });
      await vi.waitFor(() => expect(inserted).toBe(true), { timeout: 5_000 });
      const save = saveRecipe({}, editorForm(id, version, { name }));
      await vi.waitFor(async () => {
        const [{ waiting }] = await authPrisma.$queryRaw<{ waiting: bigint }[]>`
          SELECT count(*) AS waiting FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE 'UPDATE "public"."recipes"%'`;
        expect(Number(waiting)).toBeGreaterThan(0);
      }, { timeout: 10_000, interval: 50 });
      commit();
      await lookup;
      expect(await save).toMatchObject({ ok: false, fieldErrors: { name: "Another dish already answers to this name" } });
      expect((await readRecipe(id))?.name).toBe(`${RUN} kenkey`);
      expect(await audits(id, "catalog.recipe_edit")).toHaveLength(0);
    });

    it("refuses a save from an editor opened before another admin's save", async () => {
      const id = recipes.kelewele;
      const stale = await versionOf(id);
      expect(await saveRecipe({}, editorForm(id, stale, { name: `${RUN} kelewele`, servings: "2" }))).toMatchObject({ ok: true });
      const second = await saveRecipe({}, editorForm(id, stale, { name: `${RUN} kelewele`, servings: "8" }));
      expect(second).toMatchObject({ ok: false, message: expect.stringContaining("Someone else changed this dish") });
      expect((await readRecipe(id))?.servings).toBe(2);
    });

    it("is refused to a store owner and to a guest, with no write", async () => {
      const id = recipes.jollof;
      const version = await versionOf(id);
      headerState.set("cookie", ownerCookies);
      await expect(saveRecipe({}, editorForm(id, version, { name: "Owner rename" }))).rejects.toThrow("REDIRECT:/admin/sign-in");
      headerState.delete("cookie");
      await expect(saveRecipe({}, editorForm(id, version, { name: "Guest rename" }))).rejects.toThrow("REDIRECT:/admin/sign-in");
      expect((await readRecipe(id))?.name).toBe(`${RUN} jollof`);
      expect(await audits(id, "catalog.recipe_edit")).toHaveLength(0);
    });
  });

  const idForm = (recipeId: string, version: string | undefined) => {
    const form = new FormData();
    form.set("recipeId", recipeId);
    if (version) form.set("version", version);
    return form;
  };

  describe("mark curated and delete", () => {
    it("marks a looked-up dish curated with an audit row, and leaves a curated dish as it is", async () => {
      await makeRecipe("chinchinga", { origin: "lookup", sourceUrl: "https://recipes.example/chinchinga" });
      const id = recipes.chinchinga;
      expect(await markRecipeCurated({}, idForm(id, await versionOf(id)))).toMatchObject({ ok: true });
      expect((await readRecipe(id))?.origin).toBe("curated");
      const logged = await audits(id, "catalog.recipe_curate");
      expect(logged).toHaveLength(1);
      expect(logged[0]).toMatchObject({ actorId: adminId, entityType: "recipe", before: { origin: "lookup" }, after: { origin: "curated" } });
      expect(await markRecipeCurated({}, idForm(id, await versionOf(id)))).toMatchObject({ ok: false, message: "This dish is already curated" });
      expect(await audits(id, "catalog.recipe_curate")).toHaveLength(1);
    });

    it("deletes a looked-up dish with an audit row of what it held; the next request looks it up once again", async () => {
      await makeRecipe("red red", { origin: "lookup", sourceUrl: "https://recipes.example/red-red" });
      const id = recipes["red red"];
      const dish = `${RUN} red red`;
      expect(await deleteRecipe({}, idForm(id, await versionOf(id)))).toMatchObject({ ok: true });
      expect(await readRecipe(id)).toBeNull();
      const logged = await audits(id, "catalog.recipe_delete");
      expect(logged).toHaveLength(1);
      expect(logged[0]).toMatchObject({ actorId: adminId, entityType: "recipe", after: null });
      expect(logged[0].before).toMatchObject({
        key: dish, name: dish, origin: "lookup", sourceUrl: "https://recipes.example/red-red", ingredients: [{ name: "rice" }],
      });

      const storeId = crypto.randomUUID();
      await asPlatformAdmin((tx) => tx.$executeRaw`INSERT INTO stores (id, name, slug, status, updated_at) VALUES (${storeId}, ${RUN}, ${RUN + "-store"}, 'active', now())`);
      try {
        const cart = await storeScoped(storeId).cart.create({ data: { storeId, source: "ai" } });
        const talk = await storeScoped(storeId).aiConversation.create({ data: { storeId, cartId: cart.id, model: "claude-haiku-5-5", messages: [] } });
        const ctx = { storeId, cartId: cart.id, conversationId: talk.id, actorUserId: null };
        vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
        vi.stubEnv("ASSISTANT_MODEL", "");
        const fake = createFakeAnthropicFetch({ steps: [{
          kind: "tool",
          toolName: "report_ingredients",
          toolInput: { dish_name: dish, ingredients: ["black-eyed beans", "plantain"], source_url: "https://recipes.example/red-red-2" },
          webSearch: { query: `${dish} recipe`, results: [{ url: "https://recipes.example/red-red-2", title: dish }] },
        }] });
        const result = await getRecipe(ctx, { dish, servings: 2 }, { lookupModel: createAssistantModel({ fetch: fake.fetch }) });
        expect(result).toMatchObject({ ok: true, lookedUp: true, source: "https://recipes.example/red-red-2" });
        expect(fake.requests).toHaveLength(1);
        expect((await findRecipe(dish))?.ingredients.map((row) => row.name)).toEqual(["black-eyed beans", "plantain"]);
      } finally {
        vi.unstubAllEnvs();
        await storeScoped(storeId).cart.deleteMany({});
        await asPlatformAdmin((tx) => tx.$executeRaw`DELETE FROM stores WHERE id = ${storeId}`);
      }
    });

    it("refuses to delete or mark curated a dish another admin saved after this page loaded", async () => {
      await makeRecipe("banku", { origin: "lookup" });
      const id = recipes.banku;
      const stale = await versionOf(id);
      expect(await saveRecipe({}, editorForm(id, stale, { name: `${RUN} banku`, ingredients: [{ name: "corn dough" }] }))).toMatchObject({ ok: true, message: "Saved" });
      for (const action of [deleteRecipe, markRecipeCurated]) {
        expect(await action({}, idForm(id, stale))).toMatchObject({ ok: false, message: expect.stringContaining("Someone else changed this dish") });
      }
      expect(await readRecipe(id)).toMatchObject({ origin: "lookup", ingredients: [{ name: "corn dough" }] });
      expect(await audits(id, "catalog.recipe_delete")).toHaveLength(0);
      expect(await audits(id, "catalog.recipe_curate")).toHaveLength(0);
    });

    it("does not delete a curated dish", async () => {
      expect(await deleteRecipe({}, idForm(recipes.jollof, await versionOf(recipes.jollof)))).toMatchObject({ ok: false, message: "Only a dish that is not curated can be deleted. Edit a curated dish instead." });
      expect(await readRecipe(recipes.jollof)).not.toBeNull();
      expect(await audits(recipes.jollof, "catalog.recipe_delete")).toHaveLength(0);
    });

    it("is refused to a store owner and to a guest, with no write", async () => {
      await makeRecipe("fufu", { origin: "lookup", sourceUrl: "https://recipes.example/fufu" });
      const id = recipes.fufu;
      const version = await versionOf(id);
      for (const cookie of [ownerCookies, null]) {
        if (cookie) headerState.set("cookie", cookie);
        else headerState.delete("cookie");
        await expect(markRecipeCurated({}, idForm(id, version))).rejects.toThrow("REDIRECT:/admin/sign-in");
        await expect(deleteRecipe({}, idForm(id, version))).rejects.toThrow("REDIRECT:/admin/sign-in");
      }
      expect((await readRecipe(id))?.origin).toBe("lookup");
    });
  });
});
