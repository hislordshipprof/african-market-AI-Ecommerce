import { afterAll, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { generateTOTP } from "../../../e2e/totp";

vi.hoisted(() => {
  process.env.AUTH_RATE_LIMIT_RELAXED = "1";
});

const { headerState, revalidated } = vi.hoisted(() => ({ headerState: new Headers(), revalidated: [] as string[] }));

vi.mock("next/headers", () => ({
  headers: async () => headerState,
}));

vi.mock("next/cache", () => ({
  unstable_cache: (fn: () => unknown) => () => fn(),
  revalidateTag: (tag: string) => revalidated.push(tag),
  revalidatePath: () => {},
}));

// Storage boundary: R2 has no access keys on lanes, so uploads land in this map.
const { stored } = vi.hoisted(() => ({ stored: new Map<string, { body: Buffer; contentType: string }>() }));
vi.mock("../r2", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../r2")>();
  return {
    ...actual,
    uploadToR2: async (key: string, body: Buffer | Uint8Array, contentType: string) => {
      stored.set(key, { body: Buffer.from(body), contentType });
      return actual.catalogImageUrl(key);
    },
  };
});

vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`REDIRECT:${path}`);
  },
}));

import sharp from "sharp";
import { addProductSynonym, removeProductSynonym, updateProductSynonym } from "./product-synonyms";
import { createCategory, deleteCategory, getCategoryEditor, listCategoryTree, moveCategory, updateCategory, uploadCategoryImage } from "./catalog-categories";
import { getMasterProductEditor } from "./master-catalog";
import { authPrisma, storeScoped } from "../db";
import { searchListings } from "../storefront/service";
import { searchListingMatches } from "../copilot/search";
import { authPost, testSignUp, collectCookies } from "../test-auth";

const RUN = `cs${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
// Search terms share nothing with RUN, so the products' names are not trigram look-alikes of them.
const TAG = Math.random().toString(36).replace(/[^a-z]/g, "").slice(0, 5).padEnd(5, "q");
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

function form(fields: Record<string, string | Blob>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

describe("master catalog synonyms and categories (real sessions, lane DB)", () => {
  let adminId = "";
  let ownerId = "";
  let adminCookies = "";
  let ownerCookies = "";
  let categoryA = "";
  let categoryB = "";
  const products: Record<string, string> = {};
  const storeA = crypto.randomUUID();
  const storeB = crypto.randomUUID();

  beforeAll(async () => {
    adminId = await signUp(adminEmail);
    ownerId = await signUp(ownerEmail);
    await authPrisma.user.update({ where: { id: adminId }, data: { role: "platform_admin" } });
    adminCookies = await signInWith2fa(adminEmail);
    ownerCookies = await signInWith2fa(ownerEmail);

    await asPlatformAdmin(async (tx) => {
      categoryA = (await tx.category.create({ data: { name: `${RUN} Seeds`, slug: `${RUN}-seeds`, sortOrder: 950 } })).id;
      categoryB = (await tx.category.create({ data: { name: `${RUN} Nuts`, slug: `${RUN}-nuts`, sortOrder: 951 } })).id;
      const make = async (key: string, categoryId = categoryA) => {
        products[key] = (await tx.masterProduct.create({ data: { name: `${RUN} ${key}`, categoryId, status: "active" } })).id;
      };
      await make("Egusi whole");
      await make("Egusi ground");
      await make("Locust beans");
      await make("Shea nuts", categoryB);
      await tx.$executeRaw`INSERT INTO stores (id, name, slug, status, updated_at) VALUES (${storeA}, ${RUN + " A"}, ${RUN + "-a"}, 'active', now())`;
      await tx.$executeRaw`INSERT INTO stores (id, name, slug, status, updated_at) VALUES (${storeB}, ${RUN + " B"}, ${RUN + "-b"}, 'active', now())`;
    });
    // Store A sells whole egusi and locust beans; store B sells ground egusi and shea nuts.
    for (const [storeId, key] of [[storeA, "Egusi whole"], [storeA, "Locust beans"], [storeB, "Egusi ground"], [storeB, "Shea nuts"]] as const) {
      const listing = await storeScoped(storeId).listing.create({
        data: { storeId, price: 500, stockMode: "untracked", active: true, masterProductId: products[key] },
      });
      await storeScoped(storeId).listingVariant.create({ data: { listingId: listing.id, label: "1 lb", price: 500, weightG: 450 } });
    }
  }, 90_000);

  afterAll(async () => {
    await asPlatformAdmin(async (tx) => {
      const ids = Object.values(products);
      await tx.$executeRaw`DELETE FROM audit_logs WHERE actor_id IN (${adminId}, ${ownerId})`;
      await tx.$executeRaw`DELETE FROM listing_variants WHERE listing_id IN (SELECT id FROM listings WHERE store_id IN (${storeA}, ${storeB}))`;
      await tx.$executeRaw`DELETE FROM listings WHERE store_id IN (${storeA}, ${storeB})`;
      await tx.$executeRaw`DELETE FROM stores WHERE id IN (${storeA}, ${storeB})`;
      await tx.masterProduct.deleteMany({ where: { id: { in: ids } } });
      await tx.$executeRaw`DELETE FROM categories WHERE name LIKE ${RUN + "%"} AND parent_id IS NOT NULL`;
      await tx.$executeRaw`DELETE FROM categories WHERE name LIKE ${RUN + "%"}`;
      for (const userId of [adminId, ownerId]) {
        await tx.$executeRaw`DELETE FROM two_factors WHERE user_id = ${userId}`;
        await tx.$executeRaw`DELETE FROM sessions WHERE user_id = ${userId}`;
        await tx.$executeRaw`DELETE FROM accounts WHERE user_id = ${userId}`;
        await tx.$executeRaw`DELETE FROM users WHERE id = ${userId}`;
      }
    });
  });

  beforeEach(() => {
    revalidated.length = 0;
    stored.clear();
    headerState.set("cookie", adminCookies);
  });

  const auditRows = (entityId: string, action: string) =>
    asPlatformAdmin((tx) => tx.auditLog.findMany({ where: { entityId, action }, orderBy: { createdAt: "asc" } }));
  const synonymsOf = (productId: string) =>
    asPlatformAdmin((tx) => tx.productSynonym.findMany({ where: { productId }, orderBy: { createdAt: "asc" } }));

  describe("synonyms", () => {
    it("adds a synonym with a language code and region, audits it, and revalidates only the stores that list the product", async () => {
      const term = `${RUN}iru`;
      const state = await addProductSynonym({}, form({ productId: products["Locust beans"], term, language: "yo", languageOther: "", region: "Nigeria" }));
      expect(state).toMatchObject({ ok: true });
      expect(state.alsoNames ?? []).toEqual([]);

      const rows = await synonymsOf(products["Locust beans"]);
      expect(rows.map(({ term, language, region }) => ({ term, language, region }))).toEqual([{ term, language: "yo", region: "Nigeria" }]);
      const audit = await auditRows(products["Locust beans"], "catalog.synonym_add");
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ actorId: adminId, entityType: "master_product", before: null });
      expect(audit[0].after).toMatchObject({ synonymId: rows[0].id, term, language: "yo", region: "Nigeria" });
      expect(revalidated).toEqual([`storefront:${storeA}`]);
    });

    it("is found at once by the storefront search and the copilot search", async () => {
      const term = `dawadawa${TAG}`;
      expect(await searchListings(storeA, term)).toEqual([]);
      expect((await searchListingMatches(storeA, term)).outcome).toBe("none");

      await addProductSynonym({}, form({ productId: products["Locust beans"], term, language: "ha", languageOther: "", region: "" }));

      const hits = await searchListings(storeA, term);
      expect(hits.map((hit) => hit.name)).toEqual([`${RUN} Locust beans`]);
      const copilot = await searchListingMatches(storeA, term);
      expect(copilot.outcome).toBe("one");
      expect(copilot.listings.map((listing) => listing.name)).toEqual([`${RUN} Locust beans`]);
      // Store isolation: store B does not sell locust beans, so the new term finds nothing there.
      expect(await searchListings(storeB, term)).toEqual([]);
    });

    it("accepts any other ISO 639 code and refuses a language that is not a code", async () => {
      const productId = products["Locust beans"];
      const other = await addProductSynonym({}, form({ productId, term: `${RUN}soumbala`, language: "other", languageOther: "BM", region: "Mali" }));
      expect(other).toMatchObject({ ok: true });
      expect((await synonymsOf(productId)).find((row) => row.term === `${RUN}soumbala`)?.language).toBe("bm");

      const before = (await synonymsOf(productId)).length;
      const refused = await addProductSynonym({}, form({ productId, term: `${RUN}nere`, language: "other", languageOther: "Bambara", region: "" }));
      expect(refused.ok).toBe(false);
      expect(refused.fieldErrors?.language).toBeTruthy();
      const empty = await addProductSynonym({}, form({ productId, term: "   ", language: "", languageOther: "", region: "" }));
      expect(empty.fieldErrors?.term).toBeTruthy();
      expect(await synonymsOf(productId)).toHaveLength(before);
    });

    it("refuses the same term on the same product, whatever its case, language or accents", async () => {
      const productId = products["Locust beans"];
      await addProductSynonym({}, form({ productId, term: `${RUN}ogiri`, language: "yo", languageOther: "", region: "" }));
      const before = (await synonymsOf(productId)).length;

      for (const term of [`${RUN}OGIRI`, `  ${RUN}ogirí `]) {
        const state = await addProductSynonym({}, form({ productId, term, language: "ig", languageOther: "", region: "" }));
        expect(state.ok).toBe(false);
        expect(state.fieldErrors?.term).toMatch(/already/i);
      }
      expect(await synonymsOf(productId)).toHaveLength(before);
      expect(await auditRows(productId, "catalog.synonym_add")).toHaveLength(before);
    });

    it("saves a term another product already uses, and warns that it also names that product", async () => {
      const shared = `${RUN}agushi`;
      const first = await addProductSynonym({}, form({ productId: products["Egusi whole"], term: shared, language: "tw", languageOther: "", region: "Ghana" }));
      expect(first.alsoNames ?? []).toEqual([]);

      const second = await addProductSynonym({}, form({ productId: products["Egusi ground"], term: shared, language: "tw", languageOther: "", region: "Ghana" }));
      expect(second).toMatchObject({ ok: true, alsoNames: [`${RUN} Egusi whole`] });
      expect(second.message).toMatch(/also names/i);

      // The editor shows the warning on the synonym row of both products.
      const ground = await getMasterProductEditor(products["Egusi ground"]);
      expect(ground?.synonyms.find((row) => row.term === shared)?.alsoNames).toEqual([`${RUN} Egusi whole`]);
      const whole = await getMasterProductEditor(products["Egusi whole"]);
      expect(whole?.synonyms.find((row) => row.term === shared)?.alsoNames).toEqual([`${RUN} Egusi ground`]);
    });

    it("edits a synonym's term, language and region with an audit row of before and after", async () => {
      const productId = products["Egusi whole"];
      await addProductSynonym({}, form({ productId, term: `${RUN}egwusi`, language: "ig", languageOther: "", region: "" }));
      const row = (await synonymsOf(productId)).find((s) => s.term === `${RUN}egwusi`)!;
      revalidated.length = 0;

      const state = await updateProductSynonym({}, form({ productId, synonymId: row.id, term: `${RUN}egwusi melon`, language: "ig", languageOther: "", region: "Nigeria" }));
      expect(state).toMatchObject({ ok: true });
      const after = (await synonymsOf(productId)).find((s) => s.id === row.id)!;
      expect(after).toMatchObject({ term: `${RUN}egwusi melon`, language: "ig", region: "Nigeria" });
      const audit = await auditRows(productId, "catalog.synonym_edit");
      expect(audit.at(-1)?.before).toMatchObject({ synonymId: row.id, term: `${RUN}egwusi`, region: null });
      expect(audit.at(-1)?.after).toMatchObject({ synonymId: row.id, term: `${RUN}egwusi melon`, region: "Nigeria" });
      expect(revalidated).toEqual([`storefront:${storeA}`]);

      // Changing only the case of its own term is not a clash with itself.
      expect(await updateProductSynonym({}, form({ productId, synonymId: row.id, term: `${RUN}Egwusi melon`, language: "ig", languageOther: "", region: "Nigeria" }))).toMatchObject({ ok: true });
      // Renaming it onto another of the product's terms is refused.
      const clash = await updateProductSynonym({}, form({ productId, synonymId: row.id, term: `${RUN}agushi`, language: "ig", languageOther: "", region: "" }));
      expect(clash.fieldErrors?.term).toMatch(/already/i);
    });

    it("removes a synonym, audits it, and the search stops finding the product by it", async () => {
      const productId = products["Locust beans"];
      const term = `iruwoowo${TAG}`;
      await addProductSynonym({}, form({ productId, term, language: "yo", languageOther: "", region: "" }));
      const row = (await synonymsOf(productId)).find((s) => s.term === term)!;
      expect(await searchListings(storeA, term)).toHaveLength(1);
      revalidated.length = 0;

      expect(await removeProductSynonym({}, form({ productId, synonymId: row.id }))).toMatchObject({ ok: true });
      expect((await synonymsOf(productId)).some((s) => s.id === row.id)).toBe(false);
      expect((await auditRows(productId, "catalog.synonym_remove")).at(-1)?.before).toMatchObject({ synonymId: row.id, term, language: "yo" });
      expect(revalidated).toEqual([`storefront:${storeA}`]);
      expect(await searchListings(storeA, term)).toEqual([]);
    });

    it("refuses to edit or remove a synonym through another product's id", async () => {
      const row = (await synonymsOf(products["Egusi whole"]))[0];
      const edit = await updateProductSynonym({}, form({ productId: products["Locust beans"], synonymId: row.id, term: `${RUN}stolen`, language: "", languageOther: "", region: "" }));
      expect(edit.ok).toBe(false);
      const remove = await removeProductSynonym({}, form({ productId: products["Locust beans"], synonymId: row.id }));
      expect(remove.ok).toBe(false);
      expect((await synonymsOf(products["Egusi whole"])).find((s) => s.id === row.id)?.term).toBe(row.term);
    });

    it("is refused to a signed-in store owner and to a guest, with no write", async () => {
      const productId = products["Locust beans"];
      const before = (await synonymsOf(productId)).length;
      for (const cookie of [ownerCookies, ""]) {
        headerState.set("cookie", cookie);
        await expect(addProductSynonym({}, form({ productId, term: `${RUN}nope`, language: "", languageOther: "", region: "" }))).rejects.toThrow(/REDIRECT/);
        const row = (await synonymsOf(productId))[0];
        await expect(updateProductSynonym({}, form({ productId, synonymId: row.id, term: `${RUN}nope`, language: "", languageOther: "", region: "" }))).rejects.toThrow(/REDIRECT/);
        await expect(removeProductSynonym({}, form({ productId, synonymId: row.id }))).rejects.toThrow(/REDIRECT/);
      }
      expect(await synonymsOf(productId)).toHaveLength(before);
    });
  });

  describe("categories", () => {
    const categoryRow = (name: string) => asPlatformAdmin((tx) => tx.category.findFirst({ where: { name } }));
    const create = (fields: Record<string, string>) => createCategory({}, form({ name: "", localName: "", parentId: "", ...fields }));

    it("creates a category with a slug from its name and a local name, last in its level, audited", async () => {
      const state = await create({ name: `${RUN} Beans & Peas`, localName: "EWA" });
      expect(state).toMatchObject({ ok: true });
      const row = await categoryRow(`${RUN} Beans & Peas`);
      expect(row).toMatchObject({ slug: `${RUN}-beans-and-peas`, localName: "EWA", parentId: null });
      const topLevel = await asPlatformAdmin((tx) => tx.category.findMany({ where: { parentId: null }, select: { sortOrder: true } }));
      expect(row!.sortOrder).toBe(Math.max(...topLevel.map((c) => c.sortOrder)));
      const audit = await auditRows(row!.id, "catalog.category_create");
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ actorId: adminId, entityType: "category" });
      expect(audit[0].after).toMatchObject({ name: `${RUN} Beans & Peas`, slug: `${RUN}-beans-and-peas`, localName: "EWA", parentId: null });
      // Nothing lists a new category yet, so no storefront is touched.
      expect(revalidated).toEqual([]);
    });

    it("refuses a name another category has, whatever its case", async () => {
      const state = await create({ name: `${RUN} seeds` });
      expect(state.ok).toBe(false);
      expect(state.fieldErrors?.name).toMatch(/already/i);
      expect(await asPlatformAdmin((tx) => tx.category.count({ where: { name: `${RUN} seeds` } }))).toBe(0);
    });

    it("keeps the tree one level deep: a subcategory gets no children, and a parent gets no parent", async () => {
      expect(await create({ name: `${RUN} Melon seeds`, parentId: categoryA })).toMatchObject({ ok: true });
      const child = (await categoryRow(`${RUN} Melon seeds`))!;
      expect(child.parentId).toBe(categoryA);

      const grandchild = await create({ name: `${RUN} Peeled melon seeds`, parentId: child.id });
      expect(grandchild.fieldErrors?.parentId).toBeTruthy();
      expect(await categoryRow(`${RUN} Peeled melon seeds`)).toBeNull();

      const parentUnderOther = await updateCategory({}, form({ categoryId: categoryA, name: `${RUN} Seeds`, localName: "", parentId: categoryB }));
      expect(parentUnderOther.fieldErrors?.parentId).toBeTruthy();
      const self = await updateCategory({}, form({ categoryId: categoryB, name: `${RUN} Nuts`, localName: "", parentId: categoryB }));
      expect(self.fieldErrors?.parentId).toBeTruthy();
      const unknown = await create({ name: `${RUN} Orphan`, parentId: "no-such-category" });
      expect(unknown.fieldErrors?.parentId).toBeTruthy();
      expect((await categoryRow(`${RUN} Seeds`))!.parentId).toBeNull();
      expect((await categoryRow(`${RUN} Nuts`))!.parentId).toBeNull();

      const tree = await listCategoryTree();
      const seeds = tree.find((node) => node.id === categoryA)!;
      expect(seeds.children.map((node) => node.name)).toContain(`${RUN} Melon seeds`);
      expect(tree.some((node) => node.id === child.id)).toBe(false);
    });

    it("loads a category's editor with its counts, and offers only top-level parents other than itself", async () => {
      const seeds = await getCategoryEditor(categoryA);
      expect(seeds).toMatchObject({ category: { id: categoryA, name: `${RUN} Seeds`, parentId: null }, productCount: 3, childCount: 1 });
      // It has a subcategory, so it can take no parent at all.
      expect(seeds?.parents).toEqual([]);
      const child = (await categoryRow(`${RUN} Melon seeds`))!;
      const melon = await getCategoryEditor(child.id);
      expect(melon?.parents.some((p) => p.id === categoryA)).toBe(true);
      expect(melon?.parents.some((p) => p.id === child.id)).toBe(false);
      expect(await getCategoryEditor("no-such-category")).toBeNull();
    });

    it("renames and sets the local name with an audit row, keeps the slug, and revalidates only stores selling in it", async () => {
      const state = await updateCategory({}, form({ categoryId: categoryB, name: `${RUN} Nuts and kernels`, localName: "EPA", parentId: "" }));
      expect(state).toMatchObject({ ok: true });
      expect(await categoryRow(`${RUN} Nuts and kernels`)).toMatchObject({ slug: `${RUN}-nuts`, localName: "EPA" });
      const audit = await auditRows(categoryB, "catalog.category_edit");
      expect(audit.at(-1)?.before).toEqual({ name: `${RUN} Nuts`, localName: null });
      expect(audit.at(-1)?.after).toEqual({ name: `${RUN} Nuts and kernels`, localName: "EPA" });
      expect(revalidated).toEqual([`storefront:${storeB}`]);
    });

    it("moves a category up and down among its siblings, audited", async () => {
      await create({ name: `${RUN} Order parent` });
      const parent = (await categoryRow(`${RUN} Order parent`))!;
      for (const name of ["One", "Two", "Three"]) await create({ name: `${RUN} ${name}`, parentId: parent.id });
      const order = async () => (await listCategoryTree()).find((node) => node.id === parent.id)!.children.map((node) => node.name.slice(RUN.length + 1));
      expect(await order()).toEqual(["One", "Two", "Three"]);

      const three = (await categoryRow(`${RUN} Three`))!;
      expect(await moveCategory(three.id, "up")).toMatchObject({ ok: true });
      expect(await order()).toEqual(["One", "Three", "Two"]);
      expect(await moveCategory(three.id, "up")).toMatchObject({ ok: true });
      expect(await order()).toEqual(["Three", "One", "Two"]);
      // Already first: nothing moves and nothing is audited.
      expect(await moveCategory(three.id, "up")).toMatchObject({ ok: true });
      expect(await order()).toEqual(["Three", "One", "Two"]);
      expect(await moveCategory(three.id, "down")).toMatchObject({ ok: true });
      expect(await order()).toEqual(["One", "Three", "Two"]);
      expect(await auditRows(three.id, "catalog.category_move")).toHaveLength(3);
    });

    it("deletes an empty category with an audit row, and refuses one with products or subcategories", async () => {
      await create({ name: `${RUN} Empty` });
      const empty = (await categoryRow(`${RUN} Empty`))!;
      expect(await deleteCategory({}, form({ categoryId: empty.id }))).toMatchObject({ ok: true });
      expect(await categoryRow(`${RUN} Empty`)).toBeNull();
      expect((await auditRows(empty.id, "catalog.category_delete"))[0]?.before).toMatchObject({ name: `${RUN} Empty`, slug: `${RUN}-empty` });

      const withProducts = await deleteCategory({}, form({ categoryId: categoryB }));
      expect(withProducts.ok).toBe(false);
      expect(withProducts.message).toMatch(/product/i);
      const withChildren = await deleteCategory({}, form({ categoryId: categoryA }));
      expect(withChildren.ok).toBe(false);
      expect(await categoryRow(`${RUN} Nuts and kernels`)).not.toBeNull();
      expect((await asPlatformAdmin((tx) => tx.masterProduct.findUnique({ where: { id: products["Shea nuts"] } })))?.categoryId).toBe(categoryB);
    });

    it("the database also refuses deleting a category a product is in", async () => {
      await expect(asPlatformAdmin((tx) => tx.category.delete({ where: { id: categoryB } }))).rejects.toThrow();
    });

    it("re-encodes a category photo to WebP under the catalog key, audits it and revalidates stores selling in it; refuses an SVG", async () => {
      for (const [name, value] of Object.entries({ R2_ACCOUNT_ID: "acct", R2_ACCESS_KEY_ID: "key", R2_SECRET_ACCESS_KEY: "secret", R2_BUCKET: "bucket", R2_PUBLIC_URL: "" })) {
        vi.stubEnv(name, value);
      }
      onTestFinished(() => {
        vi.unstubAllEnvs();
      });
      const png = await sharp({ create: { width: 40, height: 30, channels: 3, background: "#c84" } }).png().toBuffer();
      const state = await uploadCategoryImage({}, form({ categoryId: categoryB, image: new File([new Uint8Array(png)], "x.png", { type: "image/png" }) }));
      expect(state).toMatchObject({ ok: true });
      const [key] = [...stored.keys()];
      expect(key).toMatch(new RegExp(`^catalog/${categoryB}-[0-9a-f]{16}\\.webp$`));
      expect((await sharp(stored.get(key)!.body).metadata()).format).toBe("webp");
      expect((await categoryRow(`${RUN} Nuts and kernels`))?.imageUrl).toContain(key);
      expect((await auditRows(categoryB, "catalog.category_image")).at(-1)?.after).toMatchObject({ imageUrl: expect.stringContaining(key) });
      expect(revalidated).toEqual([`storefront:${storeB}`]);

      stored.clear();
      const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');
      const refused = await uploadCategoryImage({}, form({ categoryId: categoryB, image: new File([svg], "x.png", { type: "image/png" }) }));
      expect(refused.ok).toBe(false);
      expect(stored.size).toBe(0);
    });

    it("is refused to a signed-in store owner and to a guest, with no write", async () => {
      const before = await asPlatformAdmin((tx) => tx.category.findMany({ where: { name: { startsWith: RUN } }, orderBy: { id: "asc" } }));
      for (const cookie of [ownerCookies, ""]) {
        headerState.set("cookie", cookie);
        await expect(create({ name: `${RUN} Intruder` })).rejects.toThrow(/REDIRECT/);
        await expect(updateCategory({}, form({ categoryId: categoryB, name: `${RUN} Hijacked`, localName: "", parentId: "" }))).rejects.toThrow(/REDIRECT/);
        await expect(moveCategory(categoryB, "up")).rejects.toThrow(/REDIRECT/);
        await expect(deleteCategory({}, form({ categoryId: categoryB }))).rejects.toThrow(/REDIRECT/);
        await expect(uploadCategoryImage({}, form({ categoryId: categoryB, image: new File([new Uint8Array([1])], "x.png") }))).rejects.toThrow(/REDIRECT/);
        await expect(listCategoryTree()).rejects.toThrow(/REDIRECT/);
        await expect(getCategoryEditor(categoryB)).rejects.toThrow(/REDIRECT/);
      }
      const after = await asPlatformAdmin((tx) => tx.category.findMany({ where: { name: { startsWith: RUN } }, orderBy: { id: "asc" } }));
      expect(after).toEqual(before);
    });
  });
});
