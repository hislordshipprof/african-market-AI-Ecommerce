import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { generateTOTP } from "../../../e2e/totp";

vi.hoisted(() => {
  process.env.AUTH_RATE_LIMIT_RELAXED = "1";
});

const { headerState, revalidated, fakeState } = vi.hoisted(() => ({
  headerState: new Headers(),
  revalidated: [] as string[],
  fakeState: { fetch: (async () => new Response("unscripted", { status: 500 })) as typeof fetch },
}));

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

vi.mock("../assistant/model", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../assistant/model")>();
  return {
    ...actual,
    createAssistantModel: () => actual.createAssistantModel({ fetch: fakeState.fetch }),
  };
});

import { createFakeAnthropicFetch, type RecordedMessagesRequest } from "../assistant/messages-api-double";
import { setSpendClock } from "../assistant/spend";
import { auth } from "../auth";
import { authPrisma, storeScoped } from "../db";
import { listMasterProducts } from "../listing/service";
import { dismissDuplicatePair, listDuplicatePairs, mergeDuplicatePair, scanCatalogDuplicates } from "./catalog-duplicates";
import { getMasterProductEditor, saveMasterProduct } from "./master-catalog";
import { addProductSynonym } from "./product-synonyms";

const BASE = "http://localhost:3000/api/auth";
const RUN = `dp${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
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

type Tx = Parameters<Parameters<typeof authPrisma.$transaction>[0]>[0];

async function asPlatformAdmin<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return authPrisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL ROLE app_user`;
    await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
    return fn(tx);
  });
}

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

/** Answers each judging call with the scripted verdict for every pair of this run it was sent; other pairs get none. */
function scriptVerdicts(verdicts: Map<string, { verdict: string; reason: string }>, extra: Array<Record<string, string>> = []) {
  const requests: RecordedMessagesRequest[] = [];
  fakeState.fetch = async (input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: Array<{ content: Array<{ text?: string }> }> };
    const text = body.messages?.[0]?.content.map((block) => block.text ?? "").join("") ?? "";
    const sent = [...text.matchAll(/^Pair (\S+)$/gm)].map((match) => match[1]!);
    const answer = sent.flatMap((id) => {
      const verdict = verdicts.get(id);
      return verdict ? [{ pair: id, ...verdict }] : [];
    });
    const fake = createFakeAnthropicFetch({
      expectedKey: "sk-ant-test",
      steps: [{ kind: "tool", toolName: "duplicate_verdicts", toolInput: { verdicts: [...answer, ...extra] } }],
    });
    const response = await fake.fetch(input, init);
    requests.push(...fake.requests);
    return response;
  };
  return requests;
}

describe("master catalog duplicates (real sessions, lane DB)", () => {
  let adminId = "";
  let ownerId = "";
  let adminCookies = "";
  let ownerCookies = "";
  const categories: string[] = [];
  const p: Record<string, string> = {};
  const storeA = crypto.randomUUID();
  const storeB = crypto.randomUUID();
  const listings: Record<string, string> = {};
  let recipeId = "";
  let ingredientId = "";
  let draftId = "";
  let proposalId = "";

  beforeAll(async () => {
    adminId = await signUp(adminEmail);
    ownerId = await signUp(ownerEmail);
    await authPrisma.user.update({ where: { id: adminId }, data: { role: "platform_admin" } });
    adminCookies = await signInWith2fa(adminEmail);
    ownerCookies = await signInWith2fa(ownerEmail);

    await asPlatformAdmin(async (tx) => {
      for (const name of ["Grains", "Soups", "Oils"]) {
        categories.push((await tx.category.create({ data: { name: `${RUN} ${name}`, slug: `${RUN}-${name.toLowerCase()}`, sortOrder: 900 } })).id);
      }
      const [grains, soups, oils] = categories;
      // Names carry no run prefix, which would make every pair look alike; the run's own categories keep them apart.
      const make = async (key: string, data: Record<string, unknown>, synonyms: string[] = []) => {
        p[key] = (await tx.masterProduct.create({
          data: { name: key.trim(), ...data, synonyms: { create: synonyms.map((term) => ({ term })) } } as never,
        })).id;
      };
      ingredientId = (await tx.ingredient.create({ data: { name: `${RUN} cassava` } })).id;
      await make("Gari white", { categoryId: grains, status: "active", imageUrl: "/images/products/gari.webp" }, ["garri", "white gari", "GARI WHITE"]);
      await make("Garri white", { categoryId: grains, status: "needs_review", ingredientsStatus: "reviewed", allergensStatus: "reviewed", allergens: [] }, ["Garri", "white gari", "cassava flakes"]);
      await make("Gari white old", { categoryId: grains, status: "archived" }, ["garri", "white gari"]);
      await make("Ogbono ground", { categoryId: soups, status: "active" });
      await make("Egusi", { categoryId: soups, status: "active" }, ["melon seed", "agushi"]);
      await make("Egusi seeds", { categoryId: soups, status: "active" }, ["melon seed", "agushi"]);
      await make("Ogbono ground ", { categoryId: grains, status: "active" });
      await make("Red palm oil", { categoryId: oils, status: "active", allergensStatus: "reviewed", allergens: [] }, ["palm oil", "zomi"]);
      await make("Palm oil red", { categoryId: oils, status: "active", allergensStatus: "reviewed", allergens: ["sesame"] }, ["palm oil", "zomi"]);
      await tx.masterProductIngredient.create({ data: { productId: p["Garri white"]!, ingredientId } });
      proposalId = (await tx.attributeProposal.create({
        data: { productId: p["Garri white"]!, ingredientsRead: true, ingredients: ["cassava"], allergensRead: false, dietaryRead: false },
      })).id;
      recipeId = (await tx.recipe.create({
        data: {
          key: `${RUN}-eba`, name: `${RUN} Eba`, origin: "seed",
          ingredients: { create: [{ position: 0, name: "garri", masterProductId: p["Garri white"]! }] },
        },
      })).id;
      await tx.$executeRaw`INSERT INTO stores (id, name, slug, status, updated_at) VALUES (${storeA}, ${RUN + " A"}, ${RUN + "-a"}, 'active', now())`;
      await tx.$executeRaw`INSERT INTO stores (id, name, slug, status, updated_at) VALUES (${storeB}, ${RUN + " B"}, ${RUN + "-b"}, 'active', now())`;
    });
    const list = async (key: string, storeId: string, product: string, price: number) => {
      listings[key] = (await storeScoped(storeId).listing.create({
        data: { storeId, price, stockMode: "untracked", active: true, masterProductId: p[product] },
      })).id;
      await storeScoped(storeId).listingVariant.create({ data: { listingId: listings[key]!, label: "1 kg", price, weightG: 1000 } });
    };
    // Store A lists both products; store B lists only the one that will be merged away.
    await list("aGari", storeA, "Gari white", 499);
    await list("aGarri", storeA, "Garri white", 549);
    await list("bGarri", storeB, "Garri white", 525);
    draftId = (await storeScoped(storeA).listingDraft.create({
      data: {
        storeId: storeA, createdById: ownerId, photoKey: `listing-photos/${storeA}/${RUN}.jpg`, extractedName: "Garri",
        match: "several", candidateIds: [p["Gari white"]!, p["Garri white"]!],
      },
    })).id;

    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    vi.stubEnv("ASSISTANT_MODEL", "");
    vi.stubEnv("ASSISTANT_SPEND_CAP_USD", "1000000");
    setSpendClock(() => new Date("2099-11-15T12:00:00.000Z"));
  }, 90_000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    setSpendClock(null);
    await asPlatformAdmin(async (tx) => {
      const ids = Object.values(p);
      await tx.$executeRaw`DELETE FROM audit_logs WHERE actor_id IN (${adminId}, ${ownerId})`;
      await tx.$executeRaw`DELETE FROM listing_drafts WHERE store_id IN (${storeA}, ${storeB})`;
      await tx.$executeRaw`DELETE FROM listing_variants WHERE listing_id IN (SELECT id FROM listings WHERE store_id IN (${storeA}, ${storeB}))`;
      await tx.$executeRaw`DELETE FROM listings WHERE store_id IN (${storeA}, ${storeB})`;
      await tx.$executeRaw`DELETE FROM stores WHERE id IN (${storeA}, ${storeB})`;
      await tx.recipe.deleteMany({ where: { id: recipeId } });
      await tx.catalogDuplicatePair.deleteMany({ where: { OR: [{ productAId: { in: ids } }, { productBId: { in: ids } }] } });
      await tx.masterProduct.updateMany({ where: { id: { in: ids } }, data: { mergedIntoId: null, status: "archived" } });
      await tx.masterProduct.deleteMany({ where: { id: { in: ids } } });
      await tx.ingredient.deleteMany({ where: { id: ingredientId } });
      await tx.category.deleteMany({ where: { id: { in: categories } } });
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

  const key = (a: string, b: string) => [p[a]!, p[b]!].sort().join("|");
  async function ourPairs() {
    const ids = new Set(Object.values(p));
    return (await listDuplicatePairs()).filter((pair) => ids.has(pair.a.id) || ids.has(pair.b.id));
  }
  const pairKeys = (pairs: Awaited<ReturnType<typeof ourPairs>>) => pairs.map((pair) => [pair.a.id, pair.b.id].join("|")).sort();

  it("is refused to a store owner and to a guest, with nothing written", async () => {
    for (const cookie of [ownerCookies, null]) {
      if (cookie) headerState.set("cookie", cookie);
      else headerState.delete("cookie");
      await expect(scanCatalogDuplicates()).rejects.toThrow("REDIRECT:/admin/sign-in");
      await expect(listDuplicatePairs()).rejects.toThrow("REDIRECT:/admin/sign-in");
      await expect(dismissDuplicatePair({}, form({ pairId: "x" }))).rejects.toThrow("REDIRECT:/admin/sign-in");
      await expect(mergeDuplicatePair({}, form({ pairId: "x", survivorId: p["Gari white"]! }))).rejects.toThrow("REDIRECT:/admin/sign-in");
    }
    const ids = Object.values(p);
    expect(await asPlatformAdmin((tx) => tx.catalogDuplicatePair.count({ where: { productAId: { in: ids } } }))).toBe(0);
  });

  it("with the AI spend cap resting, still proposes same-category pairs, unjudged, and calls no model", async () => {
    vi.stubEnv("ASSISTANT_SPEND_CAP_USD", "0");
    const requests = scriptVerdicts(new Map());
    try {
      const result = await scanCatalogDuplicates();
      expect(result.resting).toBe(true);
      expect(result.judged).toBe(0);
      expect(result.found).toBeLessThanOrEqual(200);
    } finally {
      vi.stubEnv("ASSISTANT_SPEND_CAP_USD", "1000000");
    }
    expect(requests).toHaveLength(0);
    expect(await asPlatformAdmin((tx) => tx.catalogDuplicatePair.count({ where: { status: "open" } }))).toBeLessThanOrEqual(200);
    const pairs = await ourPairs();
    // Near names or a shared synonym, inside one category. The archived product and the
    // same name filed under another category are never paired.
    expect(pairKeys(pairs)).toEqual([key("Gari white", "Garri white"), key("Egusi", "Egusi seeds"), key("Red palm oil", "Palm oil red")].sort());
    expect(pairs.every((pair) => pair.verdict === null)).toBe(true);
  });

  it("Claude judges the top pairs through the forced tool; verdicts for pairs it was not sent are dropped", async () => {
    const before = await ourPairs();
    const gari = before.find((pair) => [pair.a.id, pair.b.id].sort().join("|") === key("Gari white", "Garri white"))!;
    const egusi = before.find((pair) => pair.a.name.includes("Egusi"))!;
    const requests = scriptVerdicts(
      new Map([
        [gari.id, { verdict: "same", reason: "Garri is a spelling of gari; both are white cassava flakes." }],
        [egusi.id, { verdict: "unsure", reason: "Seeds may be whole or shelled." }],
      ]),
      [{ pair: "not-a-pair", verdict: "same", reason: "x" }],
    );
    const result = await scanCatalogDuplicates();
    expect(result.judgeFailed).toBe(false);
    expect(requests.length).toBeGreaterThan(0);
    const body = requests.find((request) => JSON.stringify(request.body).includes(gari.id))!.body!;
    expect(body.tool_choice).toMatchObject({ type: "tool", name: "duplicate_verdicts" });
    expect(JSON.stringify(body.messages)).toContain("cassava flakes");

    const after = await ourPairs();
    expect(after.find((pair) => pair.id === gari.id)).toMatchObject({ verdict: "same", verdictReason: "Garri is a spelling of gari; both are white cassava flakes." });
    expect(after.find((pair) => pair.id === egusi.id)).toMatchObject({ verdict: "unsure" });
    expect(after.find((pair) => pair.a.name.includes("palm"))?.verdict).toBeNull();
    expect(await asPlatformAdmin((tx) => tx.catalogDuplicatePair.count({ where: { id: "not-a-pair" } }))).toBe(0);

    // A rescan keeps the verdicts and does not send judged pairs again.
    const again = scriptVerdicts(new Map());
    await scanCatalogDuplicates();
    expect(again.some((request) => JSON.stringify(request.body).includes(gari.id))).toBe(false);
    expect((await ourPairs()).find((pair) => pair.id === gari.id)?.verdict).toBe("same");
  });

  it("shows each product with its photo, synonyms, listings per store and attributes", async () => {
    const pair = (await ourPairs()).find((row) => [row.a.id, row.b.id].sort().join("|") === key("Gari white", "Garri white"))!;
    const garri = pair.a.id === p["Garri white"] ? pair.a : pair.b;
    const gari = pair.a.id === p["Gari white"] ? pair.a : pair.b;
    expect(gari.imageUrl).toBe("/images/products/gari.webp");
    expect(gari.synonyms).toContain("white gari");
    expect(gari.stores).toEqual([{ storeId: storeA, storeName: `${RUN} A`, listings: 1 }]);
    expect(garri.stores).toEqual([
      { storeId: storeA, storeName: `${RUN} A`, listings: 1 },
      { storeId: storeB, storeName: `${RUN} B`, listings: 1 },
    ]);
    expect(garri.ingredients).toEqual({ status: "reviewed", names: [`${RUN} cassava`] });
    expect(garri.allergens).toEqual({ status: "reviewed", values: [] });
  });

  it("a store's own session sees no pairs: they are platform-admin rows only", async () => {
    const seen = await authPrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.store_id', ${storeA}, true)`;
      return tx.$queryRaw<Array<{ n: number }>>`SELECT COUNT(*)::int AS n FROM catalog_duplicate_pairs`;
    });
    expect(seen[0]!.n).toBe(0);
  });

  it("Not a duplicate is remembered: the pair is never proposed again", async () => {
    const egusi = (await ourPairs()).find((pair) => pair.a.name.includes("Egusi"))!;
    expect(await dismissDuplicatePair({}, form({ pairId: egusi.id }))).toEqual({ ok: true, message: "Marked as not a duplicate" });
    expect(await dismissDuplicatePair({}, form({ pairId: egusi.id }))).toMatchObject({ ok: false });
    scriptVerdicts(new Map());
    await scanCatalogDuplicates();
    expect(pairKeys(await ourPairs())).not.toContain(key("Egusi", "Egusi seeds"));
    const audit = await asPlatformAdmin((tx) => tx.auditLog.findFirst({ where: { action: "catalog.duplicate_dismiss", entityId: egusi.id } }));
    expect(audit?.actorId).toBe(adminId);
  });

  it("refuses a merge while both products have reviewed attribute groups that disagree, and changes nothing", async () => {
    const palm = (await ourPairs()).find((pair) => pair.a.name.toLowerCase().includes("palm"))!;
    const result = await mergeDuplicatePair({}, form({ pairId: palm.id, survivorId: p["Red palm oil"]! }));
    expect(result.ok).toBe(false);
    expect(result.message).toContain("reviewed allergens that disagree");
    const products = await asPlatformAdmin((tx) => tx.masterProduct.findMany({ where: { id: { in: [p["Red palm oil"]!, p["Palm oil red"]!] } } }));
    expect(products.map((product) => product.status).sort()).toEqual(["active", "active"]);
    expect((await ourPairs()).some((pair) => pair.id === palm.id)).toBe(true);

    // Once the admin corrects one group to match, the merge goes through.
    await asPlatformAdmin((tx) => tx.masterProduct.update({ where: { id: p["Palm oil red"]! }, data: { allergens: [] } }));
    expect(await mergeDuplicatePair({}, form({ pairId: palm.id, survivorId: p["Red palm oil"]! }))).toMatchObject({ ok: true });
  });

  it("refuses a survivor that is not one of the pair", async () => {
    const gari = (await ourPairs()).find((pair) => [pair.a.id, pair.b.id].sort().join("|") === key("Gari white", "Garri white"))!;
    expect(await mergeDuplicatePair({}, form({ pairId: gari.id, survivorId: p["Egusi"]! }))).toMatchObject({ ok: false, message: "Choose which product to keep." });
  });

  it("merges in one transaction: every listing kept and re-pointed, synonyms without repeats, recipes, drafts, ingredients, proposals, audit", async () => {
    const gari = (await ourPairs()).find((pair) => [pair.a.id, pair.b.id].sort().join("|") === key("Gari white", "Garri white"))!;
    const survivor = p["Gari white"]!;
    const loser = p["Garri white"]!;
    const listingsBefore = await asPlatformAdmin((tx) => tx.$queryRaw<Array<{ id: string; store_id: string; price: number }>>`
      SELECT id, store_id, price FROM listings WHERE store_id IN (${storeA}, ${storeB}) ORDER BY id`);

    const result = await mergeDuplicatePair({}, form({ pairId: gari.id, survivorId: survivor }));
    expect(result).toMatchObject({ ok: true, message: "Merged Garri white into Gari white. 2 listings moved." });

    const state = await asPlatformAdmin(async (tx) => ({
      listings: await tx.$queryRaw<Array<{ id: string; store_id: string; price: number; master_product_id: string }>>`
        SELECT id, store_id, price, master_product_id FROM listings WHERE store_id IN (${storeA}, ${storeB}) ORDER BY id`,
      loser: await tx.masterProduct.findUniqueOrThrow({ where: { id: loser }, include: { synonyms: true, ingredients: true } }),
      survivor: await tx.masterProduct.findUniqueOrThrow({ where: { id: survivor }, include: { synonyms: true, ingredients: true } }),
      recipe: await tx.recipeIngredient.findFirstOrThrow({ where: { recipeId } }),
      draft: await tx.$queryRaw<Array<{ master_product_id: string | null; candidate_ids: string[] }>>`
        SELECT master_product_id, candidate_ids FROM listing_drafts WHERE id = ${draftId}`,
      proposal: await tx.attributeProposal.findUniqueOrThrow({ where: { id: proposalId } }),
      pair: await tx.catalogDuplicatePair.findUniqueOrThrow({ where: { id: gari.id } }),
      audit: await tx.auditLog.findFirstOrThrow({ where: { action: "catalog.product_merge", entityId: survivor } }),
    }));

    // No listing deleted: store A keeps both of its listings, now on one product, with their own prices.
    expect(state.listings.map(({ id, store_id, price }) => ({ id, store_id, price }))).toEqual(listingsBefore);
    expect(state.listings.every((listing) => listing.master_product_id === survivor)).toBe(true);
    expect(state.listings.filter((listing) => listing.store_id === storeA)).toHaveLength(2);

    expect(state.loser).toMatchObject({ status: "merged", mergedIntoId: survivor, synonyms: [], ingredients: [] });
    const terms = state.survivor.synonyms.map((synonym) => synonym.term.toLowerCase()).sort();
    expect(terms).toEqual(["cassava flakes", "gari white", "garri", "garri white", "white gari"].sort());
    expect(new Set(terms).size).toBe(terms.length);
    // The survivor takes the reviewed groups it lacked.
    expect(state.survivor).toMatchObject({ ingredientsStatus: "reviewed", allergensStatus: "reviewed", allergens: [] });
    expect(state.survivor.ingredients.map((link) => link.ingredientId)).toEqual([ingredientId]);

    expect(state.recipe.masterProductId).toBe(survivor);
    expect(state.draft[0]).toEqual({ master_product_id: null, candidate_ids: [survivor] });
    expect(state.proposal.status).toBe("superseded");
    expect(state.pair.status).toBe("merged");
    expect(state.audit.actorId).toBe(adminId);
    expect(state.audit.after).toMatchObject({ loserId: loser, listingIds: [listings.aGarri, listings.bGarri].sort(), supersededProposals: 1 });
    expect((state.audit.before as { loser: { name: string } }).loser.name).toBe("Garri white");
    expect(revalidated.sort()).toEqual([`storefront:${storeA}`, `storefront:${storeB}`].sort());

    // Handled once: a second merge of the pair is refused and the merged product takes no new listings.
    expect(await mergeDuplicatePair({}, form({ pairId: gari.id, survivorId: survivor }))).toMatchObject({ ok: false });
    expect((await listMasterProducts("Garri white")).map((product) => product.id)).not.toContain(loser);
  });

  it("a merged product is read-only in the editor and is never proposed again", async () => {
    const editor = await getMasterProductEditor(p["Garri white"]!);
    expect(editor?.mergedInto).toEqual({ id: p["Gari white"], name: "Gari white" });
    const save = await saveMasterProduct({}, form({
      productId: p["Garri white"]!, version: editor!.product.version, name: "x", categoryId: "", subcategory: "", description: "",
      unit: "", weightG: "", storage: "", status: "active",
    }));
    expect(save).toMatchObject({ ok: false, message: "This product was merged into another one and can no longer be edited." });
    const synonym = await addProductSynonym({}, form({ productId: p["Garri white"]!, term: "garri merged", language: "", region: "" }));
    expect(synonym).toMatchObject({ ok: false, message: "This product was merged into another one and can no longer be edited." });
    expect(await authPrisma.productSynonym.count({ where: { productId: p["Garri white"]! } })).toBe(0);
    scriptVerdicts(new Map());
    await scanCatalogDuplicates();
    expect((await ourPairs()).filter((pair) => pair.a.id === p["Garri white"] || pair.b.id === p["Garri white"])).toEqual([]);
  });
});
