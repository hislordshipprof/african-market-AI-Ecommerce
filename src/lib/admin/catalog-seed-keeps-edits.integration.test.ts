import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateTOTP } from "../../../e2e/totp";

vi.hoisted(() => {
  process.env.AUTH_RATE_LIMIT_RELAXED = "1";
});

const { headerState } = vi.hoisted(() => ({ headerState: new Headers() }));

vi.mock("next/headers", () => ({
  headers: async () => headerState,
}));

vi.mock("next/cache", () => ({
  unstable_cache: (fn: () => unknown) => () => fn(),
  revalidateTag: () => {},
  revalidatePath: () => {},
}));

// Storage boundary: lanes have no R2 keys, so the admin's photo upload is kept in memory.
vi.mock("../r2", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../r2")>();
  return { ...actual, uploadToR2: async (key: string) => actual.catalogImageUrl(key) };
});

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
}));

import sharp from "sharp";
import type { PrismaClient } from "@prisma/client";
import { authPrisma } from "../db";
import { resolveDirectUrl } from "../env";
import { authPost, testSignUp, collectCookies } from "../test-auth";
import { testPrismaClient } from "../test-prisma";
import { seedMasterCatalog } from "../../../prisma/seed-master-catalog";
import { seedCategoryMetadata, type SeedCategory } from "../../../prisma/seed";
import { upsertMasterProduct } from "../../../prisma/master-catalog-upsert";
import { seedRecipeBase, type SeedRecipe } from "../assistant/recipe-base";
import { deleteCategory, moveCategory, updateCategory, uploadCategoryImage } from "./catalog-categories";
import { getRecipeEditor, saveRecipe } from "./recipe-base-admin";
import { mergeDuplicatePair } from "./catalog-duplicates";
import { getMasterProductEditor, saveMasterProduct, uploadMasterProductImage } from "./master-catalog";
import { removeProductSynonym, updateProductSynonym } from "./product-synonyms";

// #613: a re-seed of the master catalog keeps what a platform admin changed through the admin.
// #675: so do the category and curated-recipe seeds.
const RUN = `sk${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const password = "GuardPass-123!";
const adminEmail = `${RUN}-admin@test.example`;

const HEADER = [
  "id", "english_name", "local_names", "search_synonyms", "category", "subcategory", "origin_countries", "product_type",
  "common_brands", "unit", "common_pack_sizes", "typical_weight_g", "storage", "perishable", "description", "image_url",
  "image_source_page", "image_license", "image_author", "sources", "confidence", "notes",
] as const;
type Column = (typeof HEADER)[number];

function csvRow(id: string, over: Partial<Record<Column, string>> = {}): Record<Column, string> {
  const base = Object.fromEntries(HEADER.map((column) => [column, ""])) as Record<Column, string>;
  return {
    ...base, id, english_name: `${RUN} ${id}`, category: "tubers", unit: "kg", storage: "ambient", perishable: "yes",
    description: "Seeded text", confidence: "high", ...over,
  };
}

function writeCsv(rows: Array<Record<Column, string>>): string {
  const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
  const lines = [HEADER.join(","), ...rows.map((row) => HEADER.map((column) => quote(row[column])).join(","))];
  const file = path.join(mkdtempSync(path.join(tmpdir(), "t613-")), "catalog.csv");
  writeFileSync(file, `${lines.join("\n")}\n`);
  return file;
}

async function signInPlatformAdmin(): Promise<{ id: string; cookies: string }> {
  const signedUp = await testSignUp({ email: adminEmail, password, name: RUN });
  expect(signedUp.status, await signedUp.clone().text()).toBe(200);
  const id = (await authPrisma.user.findFirstOrThrow({ where: { email: adminEmail } })).id;
  await authPrisma.user.update({ where: { id }, data: { role: "platform_admin" } });
  const signedIn = await authPost("/sign-in/email", { email: adminEmail, password });
  expect(signedIn.status, await signedIn.clone().text()).toBe(200);
  const cookies = collectCookies(signedIn);
  const enabled = await authPost("/two-factor/enable", { password }, cookies);
  expect(enabled.status, await enabled.clone().text()).toBe(200);
  const secret = new URL(((await enabled.json()) as { totpURI: string }).totpURI).searchParams.get("secret");
  if (!secret) throw new Error("TOTP URI has no secret");
  const verified = await authPost("/two-factor/verify-totp", { code: generateTOTP(secret) }, cookies);
  expect(verified.status, await verified.clone().text()).toBe(200);
  return { id, cookies: collectCookies(verified) || cookies };
}

describe("master catalog seed keeps admin changes (lane DB)", () => {
  let seedClient: PrismaClient;
  let adminId = "";
  let adminCookies = "";
  const productIds: string[] = [];
  const categoryIds: string[] = [];
  const recipeKeyPrefix = RUN;

  const asPlatformAdmin = <T,>(fn: (tx: PrismaClient) => Promise<T>) =>
    seedClient.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      return fn(tx as unknown as PrismaClient);
    });
  const readProduct = (id: string) => asPlatformAdmin((tx) => tx.masterProduct.findUniqueOrThrow({ where: { id }, include: { synonyms: true } }));

  async function seed(rows: Array<Record<Column, string>>, extra: Parameters<typeof seedMasterCatalog>[1] = {}): Promise<string[]> {
    for (const row of rows) if (!productIds.includes(row.id)) productIds.push(row.id);
    const lines: string[] = [];
    await seedMasterCatalog(seedClient, {
      csvPath: writeCsv(rows),
      execution: { kind: "harness", mode: "off" },
      log: (line) => lines.push(line),
      ...extra,
    });
    return lines;
  }

  /** The editor form as the admin page loads it, with the given fields changed. */
  async function editorForm(id: string, changes: Record<string, string>): Promise<FormData> {
    const editor = await getMasterProductEditor(id);
    if (!editor) throw new Error(`no editor for ${id}`);
    const { product } = editor;
    const form = new FormData();
    const values: Record<string, string> = {
      productId: id, version: product.version, name: product.name, categoryId: product.categoryId ?? "",
      subcategory: product.subcategory ?? "", description: product.description ?? "", unit: product.unit ?? "",
      weightG: product.weightG === null ? "" : String(product.weightG), storage: product.storage ?? "", status: product.status,
      ...changes,
    };
    for (const [key, value] of Object.entries(values)) form.set(key, value);
    if (product.frozen) form.set("frozen", "on");
    if (product.perishable) form.set("perishable", "on");
    return form;
  }

  beforeAll(async () => {
    seedClient = testPrismaClient(resolveDirectUrl());
    await seedClient.$connect();
    ({ id: adminId, cookies: adminCookies } = await signInPlatformAdmin());
  }, 90_000);

  beforeEach(() => {
    headerState.set("cookie", adminCookies);
  });

  afterAll(async () => {
    if (!seedClient) return;
    await asPlatformAdmin(async (tx) => {
      if (adminId) await tx.auditLog.deleteMany({ where: { actorId: adminId } });
      await tx.catalogDuplicatePair.deleteMany({ where: { OR: [{ productAId: { in: productIds } }, { productBId: { in: productIds } }] } });
      await tx.productSynonym.deleteMany({ where: { productId: { in: productIds } } });
      await tx.masterProduct.deleteMany({ where: { id: { in: productIds }, mergedIntoId: { not: null } } });
      await tx.masterProduct.deleteMany({ where: { id: { in: productIds } } });
      await tx.recipe.deleteMany({ where: { key: { startsWith: recipeKeyPrefix } } });
      await tx.category.deleteMany({ where: { id: { in: categoryIds }, parentId: { not: null } } });
      await tx.category.deleteMany({ where: { id: { in: categoryIds } } });
      if (adminId) {
        await tx.$executeRaw`DELETE FROM two_factors WHERE user_id = ${adminId}`;
        await tx.$executeRaw`DELETE FROM sessions WHERE user_id = ${adminId}`;
        await tx.$executeRaw`DELETE FROM accounts WHERE user_id = ${adminId}`;
        await tx.$executeRaw`DELETE FROM users WHERE id = ${adminId}`;
      }
    });
    await seedClient.$disconnect();
  });

  it("an admin edit survives a re-seed; untouched fields, untouched products and new products still follow the CSV", async () => {
    const edited = `${RUN}-yam`;
    const untouched = `${RUN}-plantain`;
    await seed([csvRow(edited), csvRow(untouched)]);

    const saved = await saveMasterProduct({}, await editorForm(edited, { name: `${RUN} Yam (admin)`, description: "Admin text", categoryId: "cat_grains" }));
    expect(saved).toMatchObject({ ok: true, message: "Saved" });

    const added = `${RUN}-cassava`;
    const lines = await seed([
      csvRow(edited, { english_name: `${RUN} Yam v2`, description: "Seeded text v2", unit: "piece" }),
      csvRow(untouched, { english_name: `${RUN} Plantain v2`, description: "Seeded text v2" }),
      csvRow(added),
    ]);

    expect(await readProduct(edited)).toMatchObject({
      name: `${RUN} Yam (admin)`, description: "Admin text", categoryId: "cat_grains", unit: "piece", status: "active",
    });
    expect(await readProduct(untouched)).toMatchObject({ name: `${RUN} Plantain v2`, description: "Seeded text v2", categoryId: "cat_tubers" });
    expect(await readProduct(added)).toMatchObject({ name: `${RUN} ${added}`, status: "active" });
    expect(lines).toContain("Kept admin changes on 1 product (the fields, status and synonyms an admin changed)");
  });
  it("an archived or rejected product stays so on a re-seed that marks it active", async () => {
    const archived = `${RUN}-egusi`;
    const rejected = `${RUN}-ogbono`;
    await seed([csvRow(archived), csvRow(rejected)]);
    expect(await saveMasterProduct({}, await editorForm(archived, { status: "archived" }))).toMatchObject({ ok: true });
    expect(await saveMasterProduct({}, await editorForm(rejected, { status: "rejected" }))).toMatchObject({ ok: true });

    await seed([csvRow(archived, { description: "Seeded text v2" }), csvRow(rejected)]);

    expect(await readProduct(archived)).toMatchObject({ status: "archived", description: "Seeded text v2" });
    expect((await readProduct(rejected)).status).toBe("rejected");
  });

  it("a photo an admin uploaded survives a re-seed that brings its own image", async () => {
    const id = `${RUN}-garri`;
    await seed([csvRow(id, { image_url: "https://images.test/garri.jpg" })]);
    for (const [name, value] of Object.entries({ R2_ACCOUNT_ID: "acct", R2_ACCESS_KEY_ID: "key", R2_SECRET_ACCESS_KEY: "secret", R2_BUCKET: "bucket", R2_PUBLIC_URL: "" })) {
      vi.stubEnv(name, value);
    }
    const photo = new FormData();
    photo.set("productId", id);
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#a33" } }).png().toBuffer();
    photo.set("image", new File([new Uint8Array(png)], "garri.png", { type: "image/png" }));
    expect(await uploadMasterProductImage({}, photo)).toMatchObject({ ok: true });
    vi.unstubAllEnvs();
    const adminPhoto = (await readProduct(id)).imageUrl;
    expect(adminPhoto).toMatch(new RegExp(`/catalog/${id}-[0-9a-f]{16}\\.webp$`));

    await seed([csvRow(id, { image_url: "https://images.test/garri.jpg" })], {
      uploadImage: async () => ({ ok: true, url: "https://cdn.test/catalog/seeded.webp", bytes: 10 }),
    });

    expect((await readProduct(id)).imageUrl).toBe(adminPhoto);
  });

  it("a seeded synonym an admin edited or removed stays edited or removed", async () => {
    const id = `${RUN}-cocoyam`;
    const synonyms = { local_names: "ede (ig, Nigeria)", search_synonyms: "coco yam|taro" };
    await seed([csvRow(id, synonyms)]);
    const seeded = (await readProduct(id)).synonyms;
    const ede = seeded.find((synonym) => synonym.term === "ede")!;
    const taro = seeded.find((synonym) => synonym.term === "taro")!;

    const edit = new FormData();
    for (const [key, value] of Object.entries({ productId: id, synonymId: ede.id, term: "ede ofe", language: "ig", region: "Nigeria" })) edit.set(key, value);
    expect(await updateProductSynonym({}, edit)).toMatchObject({ ok: true });
    const remove = new FormData();
    remove.set("productId", id);
    remove.set("synonymId", taro.id);
    expect(await removeProductSynonym({}, remove)).toMatchObject({ ok: true });

    await seed([csvRow(id, synonyms)]);

    expect((await readProduct(id)).synonyms.map((synonym) => synonym.term).sort()).toEqual(["coco yam", "ede ofe"]);
  });

  it("a merged product stays merged into its survivor, with no synonyms back", async () => {
    const [survivor, loser] = [`${RUN}-melon-a`, `${RUN}-melon-b`];
    // The merge drops the loser's "egusi" (the survivor has it) and moves "agushi".
    const rows = [csvRow(survivor, { search_synonyms: "egusi" }), csvRow(loser, { search_synonyms: "agushi|egusi" })];
    await seed(rows);
    const pair = await asPlatformAdmin((tx) =>
      tx.catalogDuplicatePair.create({ data: { productAId: survivor, productBId: loser, nameSimilarity: 0.9, sharedTerms: 1, score: 0.9 } }));
    const merge = new FormData();
    merge.set("pairId", pair.id);
    merge.set("survivorId", survivor);
    expect(await mergeDuplicatePair({}, merge)).toMatchObject({ ok: true });

    const lines = await seed(rows);

    expect(await readProduct(loser)).toMatchObject({ status: "merged", mergedIntoId: survivor, synonyms: [] });
    expect((await readProduct(survivor)).synonyms.map((synonym) => synonym.term).sort()).toEqual(["agushi", "egusi", `${RUN} ${loser}`]);
    expect(lines).toContain("Kept admin changes on 1 product (the fields, status and synonyms an admin changed)");
  });

  it("category rename, photo, reorder and delete survive a re-seed; untouched categories update and new ones insert (#675)", async () => {
    const id = (name: string) => `${RUN}-cat-${name}`;
    for (const name of ["group", "other", "a", "b", "c", "d", "e"]) categoryIds.push(id(name));
    // Two sibling groups of their own, so a move here never renumbers categories other tests use.
    await asPlatformAdmin(async (tx) => {
      await tx.category.create({ data: { id: id("group"), name: `${RUN} group`, slug: `${RUN}-group`, sortOrder: 9000 } });
      await tx.category.create({ data: { id: id("other"), name: `${RUN} other`, slug: `${RUN}-other`, sortOrder: 9001 } });
      for (const [name, parent] of [["a", "group"], ["b", "group"], ["c", "group"], ["d", "other"]]) {
        await tx.category.create({ data: { id: id(name), name: `${RUN} ${name}`, slug: `${RUN}-${name}`, sortOrder: 0, parentId: id(parent) } });
      }
    });
    const category = (name: string, version: string, sortOrder: number): SeedCategory => ({
      id: id(name), name: `${RUN} ${name} ${version}`, slug: `${RUN}-${name}`, localName: `LOCAL ${version}`,
      imageUrl: `https://images.test/${name}-${version}.webp`, sortOrder,
    });
    const lines: string[] = [];
    const seedCategories = (categories: SeedCategory[]) => seedCategoryMetadata(seedClient, categories, (line) => lines.push(line));
    await seedCategories([category("a", "v1", 1), category("b", "v1", 2), category("c", "v1", 3), category("d", "v1", 1)]);

    const rename = new FormData();
    for (const [key, value] of Object.entries({ categoryId: id("a"), name: `${RUN} a (admin)`, localName: "ADMIN", parentId: id("group") })) rename.set(key, value);
    expect(await updateCategory({}, rename)).toMatchObject({ ok: true, message: "Saved" });
    for (const [name, value] of Object.entries({ R2_ACCOUNT_ID: "acct", R2_ACCESS_KEY_ID: "key", R2_SECRET_ACCESS_KEY: "secret", R2_BUCKET: "bucket", R2_PUBLIC_URL: "" })) {
      vi.stubEnv(name, value);
    }
    const photo = new FormData();
    photo.set("categoryId", id("a"));
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#3a3" } }).png().toBuffer();
    photo.set("image", new File([new Uint8Array(png)], "a.png", { type: "image/png" }));
    expect(await uploadCategoryImage({}, photo)).toMatchObject({ ok: true });
    vi.unstubAllEnvs();
    // Moving b up also renumbers a, which gets no audit row of its own.
    expect(await moveCategory(id("b"), "up")).toMatchObject({ ok: true, message: "Moved" });
    const remove = new FormData();
    remove.set("categoryId", id("c"));
    expect(await deleteCategory({}, remove)).toMatchObject({ ok: true, message: "Category deleted" });
    const readCategory = (name: string) => asPlatformAdmin((tx) => tx.category.findUnique({ where: { id: id(name) } }));
    const adminA = (await readCategory("a"))!;

    lines.length = 0;
    await seedCategories([category("a", "v2", 11), category("b", "v2", 12), category("c", "v2", 13), category("d", "v2", 14), category("e", "v2", 15)]);

    expect(await readCategory("a")).toMatchObject({
      name: `${RUN} a (admin)`, localName: "ADMIN", imageUrl: adminA.imageUrl, sortOrder: 2, parentId: id("group"),
    });
    expect(await readCategory("b")).toMatchObject({ name: `${RUN} b v2`, localName: "LOCAL v2", imageUrl: "https://images.test/b-v2.webp", sortOrder: 1 });
    expect(await readCategory("c")).toBeNull();
    expect(await readCategory("d")).toMatchObject({ name: `${RUN} d v2`, localName: "LOCAL v2", sortOrder: 14 });
    expect(await readCategory("e")).toMatchObject({ name: `${RUN} e v2`, sortOrder: 15 });
    expect(lines).toContain("Kept admin changes on 3 categories (the fields, order and deletions an admin changed)");

    // A product the seed files under the deleted category goes uncategorised, not back into a recreated one.
    const product = `${RUN}-in-deleted`;
    productIds.push(product);
    await asPlatformAdmin((tx) => upsertMasterProduct(tx as never, csvRow(product), id("c"), { statusOnCreate: "active", confidence: "high", imageUrl: null }));
    expect((await readProduct(product)).categoryId).toBeNull();
  });

  it("an admin's edits to a curated recipe survive a re-seed; untouched recipes update and new ones insert (#675)", async () => {
    const recipe = (name: string, version: string, servings: number): SeedRecipe => ({
      name: `${RUN} ${name}`, aliases: [`${RUN} ${name} ${version}`], cuisine: `Cuisine ${version}`, servings,
      ingredients: [{ name: `rice ${version}`, qty: 2, unit: "cup" }],
    });
    const lines: string[] = [];
    const seedRecipes = (recipes: SeedRecipe[]) => seedRecipeBase(seedClient, recipes, (line) => lines.push(line));
    await seedRecipes([recipe("jollof", "v1", 4), recipe("egusi", "v1", 4), recipe("moimoi", "v1", 4)]);
    const readRecipe = (key: string) => asPlatformAdmin((tx) => tx.recipe.findFirst({
      where: { OR: [{ key }, { aliases: { has: key } }] }, include: { ingredients: { orderBy: { position: "asc" } } },
    }));
    const jollofId = (await readRecipe(`${RUN} jollof`))!.id;
    const egusiId = (await readRecipe(`${RUN} egusi`))!.id;

    const form = async (recipeId: string, fields: { name?: string; servings?: string; ingredients?: Array<{ name: string; qty: string; unit: string }> }) => {
      const editor = (await getRecipeEditor(recipeId))!.recipe;
      const data = new FormData();
      data.set("recipeId", recipeId);
      data.set("version", editor.version);
      data.set("name", fields.name ?? editor.name);
      data.set("aliases", editor.aliases.join("\n"));
      data.set("servings", fields.servings ?? String(editor.servings ?? ""));
      for (const row of fields.ingredients ?? editor.ingredients.map((row) => ({ name: row.name, qty: row.qty ?? "", unit: row.unit ?? "" }))) {
        data.append("ingredientName", row.name);
        data.append("ingredientProduct", "");
        data.append("ingredientQty", row.qty);
        data.append("ingredientUnit", row.unit);
      }
      return data;
    };
    expect(await saveRecipe({}, await form(jollofId, {
      name: `${RUN} Party Jollof`, servings: "6", ingredients: [{ name: "parboiled rice", qty: "3", unit: "cup" }],
    }))).toMatchObject({ ok: true, message: "Saved" });
    expect(await saveRecipe({}, await form(egusiId, { servings: "8" }))).toMatchObject({ ok: true, message: "Saved" });

    lines.length = 0;
    await seedRecipes([recipe("jollof", "v2", 2), recipe("egusi", "v2", 2), recipe("moimoi", "v2", 2), recipe("suya", "v2", 2)]);

    const jollof = (await readRecipe(`${RUN} jollof`))!;
    expect(jollof).toMatchObject({ id: jollofId, name: `${RUN} Party Jollof`, key: `${RUN} party jollof`, servings: 6, cuisine: "Cuisine v2" });
    expect(jollof.aliases).toContain(`${RUN} jollof`);
    expect(jollof.ingredients.map((row) => [row.name, row.qty?.toString(), row.unit])).toEqual([["parboiled rice", "3", "cup"]]);
    const egusi = (await readRecipe(`${RUN} egusi`))!;
    expect(egusi).toMatchObject({ id: egusiId, servings: 8, aliases: [`${RUN} egusi v2`] });
    expect(egusi.ingredients.map((row) => row.name)).toEqual(["rice v2"]);
    expect(await readRecipe(`${RUN} moimoi`)).toMatchObject({ servings: 2, aliases: [`${RUN} moimoi v2`], cuisine: "Cuisine v2" });
    expect((await readRecipe(`${RUN} moimoi`))!.ingredients.map((row) => row.name)).toEqual(["rice v2"]);
    expect(await readRecipe(`${RUN} suya`)).toMatchObject({ servings: 2 });
    const recipeCount = await asPlatformAdmin((tx) => tx.recipe.count({ where: { key: { startsWith: RUN } } }));
    expect(recipeCount).toBe(4);
    expect(lines).toContain("Kept admin changes on 2 recipes (the fields an admin edited)");
  });
});
