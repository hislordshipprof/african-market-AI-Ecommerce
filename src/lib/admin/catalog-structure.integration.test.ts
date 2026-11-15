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
import { addProductSynonym, removeProductSynonym, updateProductSynonym } from "./product-synonyms";
import { getMasterProductEditor } from "./master-catalog";
import { auth } from "../auth";
import { authPrisma, storeScoped } from "../db";
import { searchListings } from "../storefront/service";
import { searchListingMatches } from "../copilot/search";

const BASE = "http://localhost:3000/api/auth";
const RUN = `cs${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
// Search terms share nothing with RUN, so the products' names are not trigram look-alikes of them.
const TAG = Math.random().toString(36).replace(/[^a-z]/g, "").slice(0, 5).padEnd(5, "q");
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
      const make = async (key: string) => {
        products[key] = (await tx.masterProduct.create({ data: { name: `${RUN} ${key}`, categoryId: categoryA, status: "active" } })).id;
      };
      await make("Egusi whole");
      await make("Egusi ground");
      await make("Locust beans");
      await tx.$executeRaw`INSERT INTO stores (id, name, slug, status, updated_at) VALUES (${storeA}, ${RUN + " A"}, ${RUN + "-a"}, 'active', now())`;
      await tx.$executeRaw`INSERT INTO stores (id, name, slug, status, updated_at) VALUES (${storeB}, ${RUN + " B"}, ${RUN + "-b"}, 'active', now())`;
    });
    // Store A sells whole egusi and locust beans; store B sells only ground egusi.
    for (const [storeId, key] of [[storeA, "Egusi whole"], [storeA, "Locust beans"], [storeB, "Egusi ground"]] as const) {
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
});

void sharp;
