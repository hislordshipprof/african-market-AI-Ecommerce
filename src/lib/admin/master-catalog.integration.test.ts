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

vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`REDIRECT:${path}`);
  },
}));

import { listMasterCatalog, saveMasterProduct } from "./master-catalog";
import { auth } from "../auth";
import { authPrisma, storeScoped } from "../db";
import { matchToMasterProducts } from "../listing/csv-import";
import { searchMasterProducts } from "../listing/photo-drafts";
import { listMasterProducts } from "../listing/service";
import { getListingDetail, searchListings } from "../storefront/service";

const BASE = "http://localhost:3000/api/auth";
const RUN = `mc${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const password = "GuardPass-123!";
const adminEmail = `${RUN}-admin@test.example`;
const ownerEmail = `${RUN}-owner@test.example`;

function collectCookies(res: Response): string {
  return (res.headers.getSetCookie?.() ?? []).join("; ");
}

async function authPost(path: string, body: unknown, cookies?: string): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cookies) headers.cookie = cookies;
  return auth.handler(new Request(`${BASE}${path}`, { method: "POST", headers, body: JSON.stringify(body) }));
}

async function signUp(email: string): Promise<string> {
  const res = await authPost("/sign-up/email", { email, password, name: RUN });
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

  const readProduct = (id: string) => asPlatformAdmin((tx) => tx.masterProduct.findUniqueOrThrow({ where: { id } }));
  const editAudits = (id: string) =>
    asPlatformAdmin((tx) => tx.auditLog.findMany({ where: { entityId: id, action: "catalog.product_edit" }, orderBy: { createdAt: "asc" } }));

  describe("editor", () => {
    it("saves every field and writes one audit row with the before and after values", async () => {
      const id = products["Palm oil"];
      const saved = await saveMasterProduct({}, editorForm(id, {
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
      expect(saved).toEqual({ ok: true, message: "Saved" });

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
      await saveMasterProduct({}, editorForm(products["Palm oil"], { description: "Revalidate me" }));
      expect(revalidated).toContain(`storefront:${storeA}`);
      expect(revalidated).not.toContain(`storefront:${storeB}`);
    });

    it("refuses invalid fields with a message per field and writes nothing", async () => {
      const id = products["Garri white"];
      const before = await readProduct(id);
      const refused = await saveMasterProduct({}, editorForm(id, {
        name: "   ", weightG: "12.5", storage: "fridge", status: "deleted", categoryId: "no-such-category",
      }));
      expect(refused.ok).toBeFalsy();
      expect(Object.keys(refused.fieldErrors ?? {}).sort()).toEqual(["name", "status", "storage", "weightG"]);

      const badCategory = await saveMasterProduct({}, editorForm(id, { name: `${RUN} Garri white`, categoryId: "no-such-category" }));
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
      await saveMasterProduct({}, editorForm(id, { description: "Revalidate me" }));
      const name = (await readProduct(id)).name;
      const before = await getListingDetail(storeA, palmListing);
      expect(before).not.toBeNull();
      expect((await matchToMasterProducts([name])).get(name)?.map((m) => m.product.id)).toEqual([id]);
      expect((await searchMasterProducts(storeA, name)).map((m) => m.id)).toContain(id);
      expect((await listMasterProducts(name)).map((m) => m.id)).toContain(id);

      const archived = await saveMasterProduct({}, editorForm(id, { name, description: "Revalidate me", status: "archived" }));
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
});
