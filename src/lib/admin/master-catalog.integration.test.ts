import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
import { getMasterProductEditor, listMasterCatalog, saveMasterProduct, uploadMasterProductImage } from "./master-catalog";
import { approveProduct, rejectProduct, updateReviewProduct } from "./catalog-actions";
import { authPrisma, storeScoped } from "../db";
import { matchToMasterProducts } from "../listing/csv-import";
import { searchMasterProducts } from "../listing/photo-drafts";
import { listMasterProducts } from "../listing/service";
import { getListingDetail, searchListings } from "../storefront/service";
import { authPost, testSignUp, collectCookies } from "../test-auth";

const RUN = `mc${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
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

describe("master catalog (real sessions, lane DB)", () => {
  let adminId = "";
  let ownerId = "";
  let adminCookies = "";
  let ownerCookies = "";
  let categoryA = "";
  let categoryB = "";
  const products: Record<string, string> = {};
  const storeA = crypto.randomUUID();
  const storeB = crypto.randomUUID();
  let palmListing = "";

  beforeAll(async () => {
    adminId = await signUp(adminEmail);
    ownerId = await signUp(ownerEmail);
    await authPrisma.user.update({ where: { id: adminId }, data: { role: "platform_admin" } });
    adminCookies = await signInWith2fa(adminEmail);
    ownerCookies = await signInWith2fa(ownerEmail);

    await asPlatformAdmin(async (tx) => {
      categoryA = (await tx.category.create({ data: { name: `${RUN} Grains`, slug: `${RUN}-grains`, sortOrder: 900 } })).id;
      categoryB = (await tx.category.create({ data: { name: `${RUN} Oils`, slug: `${RUN}-oils`, sortOrder: 901 } })).id;
      const make = async (key: string, data: Record<string, unknown>) => {
        products[key] = (await tx.masterProduct.create({ data: { name: `${RUN} ${key}`, ...data } as never })).id;
      };
      await make("Egusi ground", { categoryId: categoryA, status: "active", imageUrl: "/images/products/egusi.webp", ingredientsStatus: "reviewed", allergensStatus: "reviewed", dietaryStatus: "reviewed" });
      await make("Garri white", { categoryId: categoryA, status: "needs_review" });
      await make("Palm oil", { categoryId: categoryB, status: "active" });
      await make("Shea butter", { categoryId: categoryB, status: "archived" });
      await tx.$executeRaw`INSERT INTO stores (id, name, slug, status, updated_at) VALUES (${storeA}, ${RUN + " A"}, ${RUN + "-a"}, 'active', now())`;
      await tx.$executeRaw`INSERT INTO stores (id, name, slug, status, updated_at) VALUES (${storeB}, ${RUN + " B"}, ${RUN + "-b"}, 'active', now())`;
    });
    // Store A sells palm oil; store B sells only egusi.
    palmListing = (await storeScoped(storeA).listing.create({
      data: { storeId: storeA, price: 899, stockMode: "untracked", active: true, masterProductId: products["Palm oil"] },
    })).id;
    await storeScoped(storeA).listingVariant.create({ data: { listingId: palmListing, label: "1 L", price: 899, weightG: 1000 } });
    const egusiListing = (await storeScoped(storeB).listing.create({
      data: { storeId: storeB, price: 450, stockMode: "untracked", active: true, masterProductId: products["Egusi ground"] },
    })).id;
    await storeScoped(storeB).listingVariant.create({ data: { listingId: egusiListing, label: "200 g", price: 450, weightG: 200 } });
  }, 90_000);

  afterAll(async () => {
    await asPlatformAdmin(async (tx) => {
      const ids = Object.values(products);
      await tx.$executeRaw`DELETE FROM audit_logs WHERE actor_id IN (${adminId}, ${ownerId})`;
      await tx.$executeRaw`DELETE FROM listing_variants WHERE listing_id IN (SELECT id FROM listings WHERE store_id IN (${storeA}, ${storeB}))`;
      await tx.$executeRaw`DELETE FROM listings WHERE store_id IN (${storeA}, ${storeB})`;
      await tx.$executeRaw`DELETE FROM stores WHERE id IN (${storeA}, ${storeB})`;
      await tx.masterProduct.deleteMany({ where: { id: { in: ids } } });
      await tx.category.deleteMany({ where: { id: { in: [categoryA, categoryB] } } });
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

  const names = (rows: Array<{ name: string }>) => rows.map((row) => row.name.slice(RUN.length + 1)).sort();

  describe("product list", () => {
    it("finds products through the catalog search and every status by default", async () => {
      const all = await listMasterCatalog({ q: RUN });
      expect(names(all.products)).toEqual(["Egusi ground", "Garri white", "Palm oil", "Shea butter"]);
      expect(all.total).toBe(4);

      // The storefront's relevance order: the prefix match first, typo look-alikes after it.
      const egusi = await listMasterCatalog({ q: `${RUN} egusi` });
      expect(names(egusi.products.slice(0, 1))).toEqual(["Egusi ground"]);
    });

    it("treats LIKE and regex characters in the search as text", async () => {
      expect((await listMasterCatalog({ q: "%" })).products.filter((row) => row.name.startsWith(RUN))).toEqual([]);
      expect((await listMasterCatalog({ q: ".*" })).products.filter((row) => row.name.startsWith(RUN))).toEqual([]);
    });

    it("filters by category, status, missing photo and attribute status", async () => {
      expect(names((await listMasterCatalog({ q: RUN, category: categoryB })).products)).toEqual(["Palm oil", "Shea butter"]);
      expect(names((await listMasterCatalog({ q: RUN, status: "archived" })).products)).toEqual(["Shea butter"]);
      expect(names((await listMasterCatalog({ q: RUN, photo: "missing" })).products)).toEqual(["Garri white", "Palm oil", "Shea butter"]);
      expect(names((await listMasterCatalog({ q: RUN, attributes: "reviewed" })).products)).toEqual(["Egusi ground"]);
      expect(names((await listMasterCatalog({ q: RUN, attributes: "unreviewed", category: categoryA })).products)).toEqual(["Garri white"]);
    });

    it("pages through the results", async () => {
      const first = await listMasterCatalog({ q: RUN, pageSize: 3 });
      const second = await listMasterCatalog({ q: RUN, pageSize: 3, page: 2 });
      expect(first.products).toHaveLength(3);
      expect(second.products).toHaveLength(1);
      expect(first.total).toBe(4);
      expect(new Set([...first.products, ...second.products].map((row) => row.id)).size).toBe(4);
    });

    it("is refused to a signed-in user who is not a platform admin, and to a guest", async () => {
      headerState.set("cookie", ownerCookies);
      await expect(listMasterCatalog({ q: RUN })).rejects.toThrow("REDIRECT:/admin/sign-in");
      headerState.delete("cookie");
      await expect(listMasterCatalog({ q: RUN })).rejects.toThrow("REDIRECT:/admin/sign-in");
    });
  });

  function editorForm(productId: string, fields: Record<string, string | undefined> = {}): FormData {
    const values: Record<string, string | undefined> = {
      productId,
      name: `${RUN} Palm oil`,
      categoryId: categoryB,
      subcategory: "",
      description: "",
      unit: "",
      weightG: "",
      storage: "",
      status: "active",
      ...fields,
    };
    const form = new FormData();
    for (const [key, value] of Object.entries(values)) if (value !== undefined) form.set(key, value);
    return form;
  }

  /** The version the editor would load the product with now. */
  const versionOf = async (id: string) => (await getMasterProductEditor(id))?.product.version;
  const readProduct = (id: string) => asPlatformAdmin((tx) => tx.masterProduct.findUniqueOrThrow({ where: { id } }));
  const editAudits = (id: string) =>
    asPlatformAdmin((tx) => tx.auditLog.findMany({ where: { entityId: id, action: "catalog.product_edit" }, orderBy: { createdAt: "asc" } }));

  describe("editor", () => {
    it("loads the product with the category list and how many stores list it", async () => {
      const editor = await getMasterProductEditor(products["Egusi ground"]);
      expect(editor?.product).toMatchObject({ id: products["Egusi ground"], name: `${RUN} Egusi ground`, categoryId: categoryA, status: "active" });
      expect(editor?.categories.map((c) => c.id)).toEqual(expect.arrayContaining([categoryA, categoryB]));
      expect(editor?.storeCount).toBe(1);
      expect(await getMasterProductEditor("no-such-product")).toBeNull();
      headerState.set("cookie", ownerCookies);
      await expect(getMasterProductEditor(products["Egusi ground"])).rejects.toThrow("REDIRECT:/admin/sign-in");
    });

    it("saves every field and writes one audit row with the before and after values", async () => {
      const id = products["Palm oil"];
      const saved = await saveMasterProduct({}, editorForm(id, {
        version: await versionOf(id),
        name: `${RUN} Palm oil red`,
        categoryId: categoryA,
        subcategory: "Oils",
        description: "Unrefined red palm oil.",
        unit: "bottle",
        weightG: "1000",
        frozen: "on",
        perishable: "on",
        storage: "chilled",
      }));
      expect(saved).toMatchObject({ ok: true, message: "Saved" });

      expect(await readProduct(id)).toMatchObject({
        name: `${RUN} Palm oil red`,
        categoryId: categoryA,
        subcategory: "Oils",
        description: "Unrefined red palm oil.",
        unit: "bottle",
        weightG: 1000,
        frozen: true,
        perishable: true,
        storage: "chilled",
        status: "active",
      });
      const audits = await editAudits(id);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ actorId: adminId, actorEmail: adminEmail, entityType: "master_product" });
      expect(audits[0].before).toEqual({
        name: `${RUN} Palm oil`, categoryId: categoryB, subcategory: null, description: null, unit: null,
        weightG: null, frozen: false, perishable: false, storage: null,
      });
      expect(audits[0].after).toEqual({
        name: `${RUN} Palm oil red`, categoryId: categoryA, subcategory: "Oils", description: "Unrefined red palm oil.", unit: "bottle",
        weightG: 1000, frozen: true, perishable: true, storage: "chilled",
      });
    });

    it("revalidates the storefront of every store that lists the product, and no other store", async () => {
      const id = products["Palm oil"];
      await saveMasterProduct({}, editorForm(id, { version: await versionOf(id), description: "Revalidate me" }));
      expect(revalidated).toContain(`storefront:${storeA}`);
      expect(revalidated).not.toContain(`storefront:${storeB}`);
    });

    it("refuses invalid fields with a message per field and writes nothing", async () => {
      const id = products["Garri white"];
      const before = await readProduct(id);
      const version = await versionOf(id);
      const refused = await saveMasterProduct({}, editorForm(id, {
        version,
        name: "   ", weightG: "12.5", storage: "fridge", status: "deleted", categoryId: "no-such-category",
      }));
      expect(refused.ok).toBeFalsy();
      expect(Object.keys(refused.fieldErrors ?? {}).sort()).toEqual(["name", "status", "storage", "weightG"]);

      const badCategory = await saveMasterProduct({}, editorForm(id, { version, name: `${RUN} Garri white`, categoryId: "no-such-category" }));
      expect(badCategory.fieldErrors?.categoryId).toBeTruthy();
      expect(await readProduct(id)).toEqual(before);
      expect(await editAudits(id)).toHaveLength(0);
    });

    it("is refused to a store owner and to a guest, with no write", async () => {
      const id = products["Egusi ground"];
      headerState.set("cookie", ownerCookies);
      await expect(saveMasterProduct({}, editorForm(id, { name: "Owner rename" }))).rejects.toThrow("REDIRECT:/admin/sign-in");
      headerState.delete("cookie");
      await expect(saveMasterProduct({}, editorForm(id, { name: "Guest rename" }))).rejects.toThrow("REDIRECT:/admin/sign-in");
      expect((await readProduct(id)).name).toBe(`${RUN} Egusi ground`);
      expect(await editAudits(id)).toHaveLength(0);
    });
  });

  describe("archive", () => {
    it("removes the product from CSV, AI and manual match candidates while its listings keep selling unchanged", async () => {
      const id = products["Palm oil"];
      // The form as the editor shows it after the save above, with only the status changed.
      await saveMasterProduct({}, editorForm(id, { version: await versionOf(id), description: "Revalidate me" }));
      const name = (await readProduct(id)).name;
      const before = await getListingDetail(storeA, palmListing);
      expect(before).not.toBeNull();
      expect((await matchToMasterProducts([name])).get(name)?.map((m) => m.product.id)).toEqual([id]);
      expect((await searchMasterProducts(storeA, name)).map((m) => m.id)).toContain(id);
      expect((await listMasterProducts(name)).map((m) => m.id)).toContain(id);

      const archived = await saveMasterProduct({}, editorForm(id, { version: await versionOf(id), name, description: "Revalidate me", status: "archived" }));
      expect(archived.ok).toBe(true);
      expect((await readProduct(id)).status).toBe("archived");
      expect(revalidated).toContain(`storefront:${storeA}`);

      expect((await matchToMasterProducts([name])).get(name)).toEqual([]);
      expect((await searchMasterProducts(storeA, name)).map((m) => m.id)).not.toContain(id);
      expect((await listMasterProducts(name)).map((m) => m.id)).not.toContain(id);

      expect(await getListingDetail(storeA, palmListing)).toEqual(before);
      expect((await searchListings(storeA, name)).map((hit) => hit.id)).toContain(palmListing);
      const audit = (await editAudits(id)).at(-1);
      expect(audit?.before).toEqual({ status: "active" });
      expect(audit?.after).toEqual({ status: "archived" });
    });
  });

  describe("two editors on one product", () => {
    /** Opens the editor and returns its form as the browser would submit it, with the admin's changes on top. */
    async function openEditor(id: string) {
      const editor = await getMasterProductEditor(id);
      if (!editor) throw new Error("product not found");
      const { product } = editor;
      return (changes: Record<string, string | undefined> = {}) => {
        const values: Record<string, string | undefined> = {
          productId: product.id,
          version: product.version,
          name: product.name,
          categoryId: product.categoryId ?? "",
          subcategory: product.subcategory ?? "",
          description: product.description ?? "",
          unit: product.unit ?? "",
          weightG: product.weightG === null ? "" : String(product.weightG),
          frozen: product.frozen ? "on" : undefined,
          perishable: product.perishable ? "on" : undefined,
          storage: product.storage ?? "",
          status: product.status,
          ...changes,
        };
        const form = new FormData();
        for (const [key, value] of Object.entries(values)) if (value !== undefined) form.set(key, value);
        return form;
      };
    }

    async function makeProduct(key: string, status = "active"): Promise<string> {
      const id = await asPlatformAdmin(async (tx) =>
        (await tx.masterProduct.create({ data: { name: `${RUN} ${key}`, categoryId: categoryB, status } })).id);
      products[key] = id;
      return id;
    }

    it("refuses the second editor's save when the first saved after it opened, and keeps the first editor's changes", async () => {
      const id = await makeProduct("Ogbono");
      const editorA = await openEditor(id);
      const editorB = await openEditor(id);

      expect(await saveMasterProduct({}, editorA({ name: `${RUN} Ogbono seeds` }))).toMatchObject({ ok: true, message: "Saved" });
      const stale = await saveMasterProduct({}, editorB({ description: "Second editor's description" }));
      expect(stale.ok).toBe(false);
      expect(stale.message).toMatch(/changed .* after you opened it.*reload/i);

      expect(await readProduct(id)).toMatchObject({ name: `${RUN} Ogbono seeds`, description: null, status: "active" });
      expect((await editAudits(id)).map((row) => row.after)).toEqual([{ name: `${RUN} Ogbono seeds` }]);

      // After a reload the same change saves, and only the field the admin changed is written.
      expect(await saveMasterProduct({}, (await openEditor(id))({ description: "Second editor's description" }))).toMatchObject({ ok: true });
      expect(await readProduct(id)).toMatchObject({ name: `${RUN} Ogbono seeds`, description: "Second editor's description" });
      expect((await editAudits(id)).at(-1)?.after).toEqual({ description: "Second editor's description" });
    });

    it("never un-archives a product from a form opened before the archive", async () => {
      const id = await makeProduct("Locust beans");
      const editorA = await openEditor(id);
      const editorB = await openEditor(id);

      expect(await saveMasterProduct({}, editorA({ status: "archived" }))).toMatchObject({ ok: true });
      expect((await saveMasterProduct({}, editorB({ unit: "pack" }))).ok).toBe(false);

      expect(await readProduct(id)).toMatchObject({ status: "archived", unit: null });
      expect((await matchToMasterProducts([`${RUN} Locust beans`])).get(`${RUN} Locust beans`)).toEqual([]);
    });

    const reviewAudits = (id: string) =>
      asPlatformAdmin((tx) => tx.auditLog.findMany({ where: { entityId: id, action: { in: ["catalog.approve", "catalog.reject", "catalog.edit"] } } }));

    /** The admin opened Catalog review on the product, then another admin archived it in the editor. */
    async function archivedBehindTheQueue(key: string, queueStatus: string): Promise<string> {
      const id = await makeProduct(key, queueStatus);
      expect(await saveMasterProduct({}, (await openEditor(id))({ status: "archived" }))).toMatchObject({ ok: true });
      return id;
    }

    it("keeps a product archived when a review queue opened before the archive approves it", async () => {
      const id = await archivedBehindTheQueue("Bitter leaf", "needs_review");

      expect((await approveProduct(id, "needs_review")).error).toMatch(/changed .* after you opened it.*reload/i);
      expect((await approveProduct(id, "archived")).error).toMatch(/changed .* after you opened it.*reload/i);

      expect(await readProduct(id)).toMatchObject({ status: "archived" });
      expect(await reviewAudits(id)).toEqual([]);
      expect((await matchToMasterProducts([`${RUN} Bitter leaf`])).get(`${RUN} Bitter leaf`)).toEqual([]);
    });

    it("keeps a product archived when a review queue opened before the archive rejects it", async () => {
      const id = await archivedBehindTheQueue("Uziza", "active");

      expect((await rejectProduct(id, "active")).error).toMatch(/changed .* after you opened it.*reload/i);
      expect((await rejectProduct(id, "archived")).error).toMatch(/changed .* after you opened it.*reload/i);

      expect(await readProduct(id)).toMatchObject({ status: "archived" });
      expect(await reviewAudits(id)).toEqual([]);
    });

    it("refuses the review dialog's edit to a product archived after the queue opened", async () => {
      const id = await archivedBehindTheQueue("Ugu", "rejected");

      expect((await updateReviewProduct(id, "rejected", { name: `${RUN} Fluted pumpkin` })).error).toMatch(/changed .* after you opened it.*reload/i);

      expect(await readProduct(id)).toMatchObject({ status: "archived", name: `${RUN} Ugu` });
      expect(await reviewAudits(id)).toEqual([]);
    });

    it("lets one editor save twice in a row with the version its last save returned", async () => {
      const id = await makeProduct("Crayfish");
      const editor = await openEditor(id);
      const first = await saveMasterProduct({}, editor({ unit: "bag" }));
      expect(first).toMatchObject({ ok: true });
      const form = editor({ unit: "bag", weightG: "500" });
      form.set("version", first.version ?? "");
      expect(await saveMasterProduct({}, form)).toMatchObject({ ok: true, message: "Saved" });
      expect(await readProduct(id)).toMatchObject({ unit: "bag", weightG: 500 });
    });

    it("does not count a photo upload as someone else's change to the details", async () => {
      const id = await makeProduct("Dried fish");
      const editor = await openEditor(id);
      for (const [name, value] of Object.entries({ R2_ACCOUNT_ID: "acct", R2_ACCESS_KEY_ID: "key", R2_SECRET_ACCESS_KEY: "secret", R2_BUCKET: "bucket", R2_PUBLIC_URL: "" })) {
        vi.stubEnv(name, value);
      }
      const photo = new FormData();
      photo.set("productId", id);
      const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#a33" } }).png().toBuffer();
      photo.set("image", new File([new Uint8Array(png)], "fish.png", { type: "image/png" }));
      expect(await uploadMasterProductImage({}, photo)).toMatchObject({ ok: true });
      vi.unstubAllEnvs();

      expect(await saveMasterProduct({}, editor({ unit: "pack" }))).toMatchObject({ ok: true, message: "Saved" });
    });
  });

  describe("image upload", () => {
    const r2 = { R2_ACCOUNT_ID: "acct", R2_ACCESS_KEY_ID: "key", R2_SECRET_ACCESS_KEY: "secret", R2_BUCKET: "bucket", R2_PUBLIC_URL: "" };
    beforeEach(() => {
      for (const [name, value] of Object.entries(r2)) vi.stubEnv(name, value);
    });
    afterAll(() => vi.unstubAllEnvs());

    function imageForm(productId: string, bytes: Uint8Array, name: string, type: string): FormData {
      const form = new FormData();
      form.set("productId", productId);
      form.set("image", new File([Buffer.from(bytes)], name, { type }));
      return form;
    }
    const imageAudits = (id: string) =>
      asPlatformAdmin((tx) => tx.auditLog.findMany({ where: { entityId: id, action: "catalog.product_image" } }));
    const png = () => sharp({ create: { width: 1600, height: 1200, channels: 3, background: "#c33" } }).png().toBuffer();

    it("re-encodes a photo to WebP under the catalog key, points the product at it and audits it", async () => {
      const id = products["Egusi ground"];
      const result = await uploadMasterProductImage({}, imageForm(id, await png(), "egusi.png", "image/png"));
      expect(result).toEqual({ ok: true, message: "Photo updated" });

      expect(stored.size).toBe(1);
      const [[key, object]] = [...stored.entries()];
      expect(key).toMatch(new RegExp(`^catalog/${id}-[0-9a-f]{16}\\.webp$`));
      expect(object.contentType).toBe("image/webp");
      const meta = await sharp(object.body).metadata();
      expect(meta.format).toBe("webp");
      expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBe(960);

      expect((await readProduct(id)).imageUrl).toBe(`/api/catalog-image/${key}`);
      const audits = await imageAudits(id);
      expect(audits).toHaveLength(1);
      expect(audits[0].before).toEqual({ imageUrl: "/images/products/egusi.webp" });
      expect(audits[0].after).toEqual({ imageUrl: `/api/catalog-image/${key}` });
      expect(revalidated).toEqual([`storefront:${storeB}`]);
    });

    it("refuses an SVG and a file whose bytes are not a photo, whatever type the browser claimed", async () => {
      const id = products["Garri white"];
      const svg = new TextEncoder().encode('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
      const svgResult = await uploadMasterProductImage({}, imageForm(id, svg, "garri.png", "image/png"));
      expect(svgResult.ok).toBeFalsy();
      expect(svgResult.message).toMatch(/SVG/);

      const text = new TextEncoder().encode("not a photo at all");
      const textResult = await uploadMasterProductImage({}, imageForm(id, text, "garri.jpg", "image/jpeg"));
      expect(textResult.ok).toBeFalsy();
      expect(textResult.message).toMatch(/JPEG, PNG or WebP/);

      // Right magic bytes, broken body: sharp must fail it rather than store it.
      const truncated = (await png()).subarray(0, 64);
      expect((await uploadMasterProductImage({}, imageForm(id, truncated, "garri.png", "image/png"))).ok).toBeFalsy();

      expect(stored.size).toBe(0);
      expect((await readProduct(id)).imageUrl).toBeNull();
      expect(await imageAudits(id)).toHaveLength(0);
    });

    it("says photo storage is not set up when R2 has no keys, and stores nothing", async () => {
      vi.stubEnv("R2_SECRET_ACCESS_KEY", "");
      const id = products["Garri white"];
      const result = await uploadMasterProductImage({}, imageForm(id, await png(), "garri.png", "image/png"));
      expect(result).toEqual({ ok: false, message: "Photo storage is not set up." });
      expect(stored.size).toBe(0);
    });

    it("is refused to a store owner and to a guest, with nothing stored", async () => {
      const id = products["Garri white"];
      headerState.set("cookie", ownerCookies);
      await expect(uploadMasterProductImage({}, imageForm(id, await png(), "x.png", "image/png"))).rejects.toThrow("REDIRECT:/admin/sign-in");
      headerState.delete("cookie");
      await expect(uploadMasterProductImage({}, imageForm(id, await png(), "x.png", "image/png"))).rejects.toThrow("REDIRECT:/admin/sign-in");
      expect(stored.size).toBe(0);
      expect((await readProduct(id)).imageUrl).toBeNull();
    });
  });
});
