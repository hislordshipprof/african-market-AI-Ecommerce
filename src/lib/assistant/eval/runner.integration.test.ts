import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { platformAdmin, platformSessionUser, storeScoped } from "../../db";
import { createFakeAnthropicFetch, type FakeAnthropicStep } from "../messages-api-double";
import { createEvalStores, deleteOwnedStores, sweepAbandonedEvalStores, writeLease, type CreatedEvalStores } from "./fixture-store";
import { loadDataset, loadFixture, validateDataset, validateFixture } from "./dataset";
import { publishEvalReport, buildReport } from "./report";
import { fingerprintFromParts } from "./fingerprint";
import { runEval, type AttemptContext } from "./runner";
import { bindingFromFixture, scoreCase, type CatalogBinding } from "./score";
import type { CatalogFixture, EvalCase, FixtureListing } from "./types";

vi.mock("next/cache", () => ({
  unstable_cache: (fn: () => unknown) => fn,
  revalidateTag: () => {},
}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined, set: () => undefined }),
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));

const KEY = "sk-ant-test";
const hasDb = !!process.env.DATABASE_URL;
const days = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

function fixture(listings: FixtureListing[]): CatalogFixture {
  return {
    schemaVersion: 1,
    pinnedNow: "2026-06-15T16:00:00.000Z",
    store: {
      name: "Golden Eval Market",
      timezone: "America/Chicago",
      hours: Object.fromEntries(days.map((day) => [day, { open: "09:00", close: "21:00" }])),
      minimumOrderCents: 1500,
      pickupEnabled: true,
    },
    listings,
  };
}

function listing(key: string, masterProductId: string, store: "A" | "B", priceCents: number, extra: Partial<FixtureListing> = {}): FixtureListing {
  return {
    key,
    masterProductId,
    priceCents,
    stockMode: "unlimited",
    qty: null,
    status: null,
    confidence: 1,
    active: true,
    maxPerOrder: null,
    variants: [{ key: `${key}-pack`, label: "5 lb", priceCents, weightG: 2268 }],
    store,
    ...extra,
  };
}

function evalCase(partial: EvalCase): EvalCase {
  return partial;
}

function steps(script: FakeAnthropicStep[]): FakeAnthropicStep[] {
  return script;
}

async function scripted(ctx: AttemptContext, script: FakeAnthropicStep[] | ((ctx: AttemptContext) => FakeAnthropicStep[])) {
  const chosen = typeof script === "function" ? script(ctx) : script;
  const fake = createFakeAnthropicFetch({ expectedKey: KEY, steps: chosen });
  return fake.fetch;
}

describe.skipIf(!hasDb)("shopper assistant eval runner", () => {
  const leftover: CreatedEvalStores[] = [];

  afterEach(async () => {
    vi.unstubAllEnvs();
    while (leftover.length > 0) {
      const stores = leftover.pop();
      if (stores) await deleteOwnedStores(stores).catch(() => {});
    }
  });

  function run(cases: EvalCase[], listings: FixtureListing[], fetchForAttempt: (ctx: AttemptContext) => Promise<typeof fetch> | typeof fetch, extra: Partial<Parameters<typeof runEval>[0]> = {}) {
    vi.stubEnv("ANTHROPIC_API_KEY", KEY);
    vi.stubEnv("ASSISTANT_MODEL", "claude-haiku-5-5");
    vi.stubEnv("ASSISTANT_SPEND_CAP_USD", "1000000");
    return runEval({
      cases,
      fixture: fixture(listings),
      now: new Date("2026-06-15T16:00:00.000Z"),
      concurrency: 1,
      maxMicros: BigInt(2000000),
      priorTicketMicros: BigInt(0),
      ticketCapMicros: BigInt(4000000),
      full: false,
      fetchForAttempt,
      settleTimeoutMs: 8_000,
      stripTimeoutMs: 8_000,
      retryDelayMs: () => 0,
      ...extra,
    });
  }

  it("a scripted model that invents an item, adds another store's item and states an unreturned price fails the case with two hallucinated items and one stripped amount", async () => {
    const listings = [
      listing("garri", "garri-white", "A", 499),
      listing("yam", "yam-white-puna", "B", 899),
    ];
    const expected = evalCase({
      id: "adds-garri",
      category: "single-item",
      turns: ["Add 1 garri."],
      mustHave: [{ options: [{ listingKey: "garri", variantKeys: ["garri-pack"] }] }],
      mayHave: [],
      gaps: [],
      qty: [{ listingKey: "garri", variantKey: "garri-pack", min: 1, max: 1 }],
    });
    const invented = evalCase({
      id: "invents-items",
      category: "single-item",
      turns: ["Add the other one."],
      mustHave: [{ options: [{ listingKey: "garri", variantKeys: ["garri-pack"] }] }],
      mayHave: [],
      gaps: [],
    });
    const result = await run([expected, invented], listings, (ctx) => scripted(ctx, (current) => {
      if (current.caseId === "adds-garri") {
        const variantId = current.binding.byVariantKey.get("garri-pack")?.id ?? "";
        return steps([
          { kind: "tool", toolName: "add_to_cart", toolInput: { items: [{ variant_id: variantId, qty: 1 }] } },
          { kind: "text", text: "Added." },
        ]);
      }
      const other = current.binding.byVariantKey.get("yam-pack")?.id ?? "";
      return steps([
        { kind: "tool", toolName: "add_to_cart", toolInput: { items: [{ variant_id: "missing-variant", qty: 1 }, { variant_id: other, qty: 1 }] } },
        { kind: "text", text: "That one is $9.99." },
      ]);
    }));
    const added = result.result.cases.find((item) => item.id === "adds-garri");
    const failed = result.result.cases.find((item) => item.id === "invents-items");
    expect(added?.precision).toBe(1);
    expect(added?.recall).toBe(1);
    expect(added?.pass).toBe(true);
    expect(failed?.hallucinated).toHaveLength(2);
    expect(failed?.hallucinated.filter((item) => item.crossStore)).toHaveLength(1);
    expect(failed?.strippedAmounts).toHaveLength(1);
    expect(failed?.ungroundedAmountsShown).toEqual([]);
  }, 90_000);

  it("reads evidence as app_runtime and denies another store read and write", async () => {
    const listings = [listing("garri", "garri-white", "A", 499), listing("yam", "yam-white-puna", "B", 899)];
    const result = await run([evalCase({
      id: "role-check",
      category: "single-item",
      turns: ["Add 1 garri."],
      mustHave: [{ options: [{ listingKey: "garri", variantKeys: ["garri-pack"] }] }],
      mayHave: [],
      gaps: [],
    })], listings, (ctx) => scripted(ctx, (current) => [{
      kind: "tool",
      toolName: "add_to_cart",
      toolInput: { items: [{ variant_id: current.binding.byVariantKey.get("garri-pack")?.id ?? "", qty: 1 }] },
    }, { kind: "text", text: "Added." }]), {
      cleanup: async (stores) => {
        leftover.push(stores);
        expect(await platformSessionUser()).toBe("app_runtime");
        const hidden = await storeScoped(stores.storeAId).listing.findMany({ where: { storeId: stores.storeBId } });
        expect(hidden).toEqual([]);
        await expect(storeScoped(stores.storeAId).listing.create({
          data: {
            storeId: stores.storeBId,
            masterProductId: "garri-white",
            price: 100,
            stockMode: "unlimited",
            confidence: 1,
            active: true,
            frozen: false,
            perishable: false,
          },
        })).rejects.toThrow();
        await deleteOwnedStores(stores);
        leftover.pop();
      },
    });
    expect(result.result.sessionUser).toBe("app_runtime");
  }, 90_000);

  it("scores every nested id field and invalid-schema calls without relying on audit rows", async () => {
    const listings = [listing("garri", "garri-white", "A", 499), listing("yam", "yam-white-puna", "B", 899)];
    let invalidWasAudited = true;
    const result = await run([evalCase({
      id: "nested-ids",
      category: "single-item",
      turns: ["Show me options."],
      mustHave: [{ options: [{ listingKey: "garri", variantKeys: ["garri-pack"] }] }],
      mayHave: [],
      gaps: [],
    })], listings, (ctx) => scripted(ctx, (current) => {
      const good = current.binding.byVariantKey.get("garri-pack");
      const decoy = current.binding.byListingKey.get("yam");
      return [
        { kind: "tool", toolName: "show_products", toolInput: { listing_ids: ["missing-listing", decoy?.id ?? ""] } },
        { kind: "tool", toolName: "suggest_substitutes", toolInput: { listing_id: "missing-sub" } },
        { kind: "tool", toolName: "add_to_cart", toolInput: { items: [{ variant_id: good?.id ?? "", qty: 1, backup_variant_id: "missing-backup" }] } },
        { kind: "tool", toolName: "offer_choices", toolInput: { options: [{ listing_id: good?.listingId ?? "" }, { listing_id: "missing-option", variant_id: "missing-option-variant" }] } },
        { kind: "tool", toolName: "set_swap_rule", toolInput: { line_id: "missing-line", rule: "named_substitute", substitute_variant_id: "missing-named" } },
        { kind: "tool", toolName: "add_to_cart", toolInput: { items: [{ variant_id: "schema-invalid-id", qty: 0 }] } },
        { kind: "text", text: "Done." },
      ];
    }), {
      maxAttempts: 1,
      cleanup: async (stores) => {
        const actions = await storeScoped(stores.storeAId).aiAction.findMany({ where: { storeId: stores.storeAId } });
        invalidWasAudited = actions.some((action) => JSON.stringify(action.input).includes("schema-invalid-id"));
        await deleteOwnedStores(stores);
      },
    });
    const scored = result.result.cases[0];
    const fields = new Set(scored?.hallucinated.map((item) => item.field));
    expect(fields.has("listing_ids")).toBe(true);
    expect(fields.has("listing_id")).toBe(true);
    expect(fields.has("backup_variant_id")).toBe(true);
    expect(fields.has("variant_id")).toBe(true);
    expect(fields.has("line_id")).toBe(true);
    expect(fields.has("substitute_variant_id")).toBe(true);
    expect(scored?.hallucinated.some((item) => item.id === "schema-invalid-id")).toBe(true);
    expect(scored?.hallucinated.some((item) => item.crossStore)).toBe(true);
    expect(invalidWasAudited).toBe(false);
  }, 90_000);

  it("rejects wrong resource types and another cart line in the same store", async () => {
    const listings = [listing("garri", "garri-white", "A", 499), listing("yam", "yam-white-puna", "B", 899)];
    let foreignLine = "";
    const result = await run([evalCase({
      id: "wrong-type",
      category: "single-item",
      turns: ["Update the other cart."],
      mustHave: [{ options: [{ listingKey: "garri", variantKeys: ["garri-pack"] }] }],
      mayHave: [],
      gaps: [],
    })], listings, async (ctx) => {
      const variantId = ctx.binding.byVariantKey.get("garri-pack")?.id ?? "";
      const listingId = ctx.binding.byListingKey.get("garri")?.id ?? "";
      const cart = await storeScoped(ctx.stores.storeAId).cart.create({ data: { storeId: ctx.stores.storeAId } });
      const line = await storeScoped(ctx.stores.storeAId).cartLine.create({
        data: { storeId: ctx.stores.storeAId, cartId: cart.id, variantId, qty: 1, swapRule: "exact_only" },
      });
      foreignLine = line.id;
      return scripted(ctx, [
        { kind: "tool", toolName: "add_to_cart", toolInput: { items: [{ variant_id: listingId, qty: 1 }] } },
        { kind: "tool", toolName: "update_cart", toolInput: { line_id: line.id, qty: 2 } },
        { kind: "text", text: "Done." },
      ]);
    }, { maxAttempts: 1 });
    const scored = result.result.cases[0];
    expect(scored?.pass).toBe(false);
    expect(scored?.hallucinated.some((item) => item.field === "variant_id" && item.crossStore === false)).toBe(true);
    expect(scored?.hallucinated.some((item) => item.field === "line_id" && item.id === foreignLine)).toBe(true);
  }, 90_000);

  it("an audit failure invalidates the attempt even if a later tool succeeds", async () => {
    const listings = [listing("garri", "garri-white", "A", 499), listing("yam", "yam-white-puna", "B", 899)];
    const result = await run([evalCase({
      id: "audit-gap",
      category: "single-item",
      turns: ["Add 1 garri."],
      mustHave: [{ options: [{ listingKey: "garri", variantKeys: ["garri-pack"] }] }],
      mayHave: [],
      gaps: [],
    })], listings, async (ctx) => {
      let calls = 0;
      let saved: { id: string; cartId: string; messages: unknown } | null = null;
      const variantId = ctx.binding.byVariantKey.get("garri-pack")?.id ?? "";
      const fake = createFakeAnthropicFetch({
        expectedKey: KEY,
        steps: [
          { kind: "tool", toolName: "search_catalog", toolInput: { query: "garri" } },
          { kind: "tool", toolName: "add_to_cart", toolInput: { items: [{ variant_id: variantId, qty: 1 }] } },
          { kind: "text", text: "Added." },
        ],
      });
      return async (input, init) => {
        calls += 1;
        if (calls === 1) {
          const row = await storeScoped(ctx.stores.storeAId).aiConversation.findFirst({ where: { storeId: ctx.stores.storeAId } });
          if (!row) throw new Error("conversation missing");
          saved = { id: row.id, cartId: row.cartId, messages: row.messages };
          await storeScoped(ctx.stores.storeAId).aiConversation.delete({ where: { id: row.id } });
        }
        if (calls === 2 && saved) {
          await storeScoped(ctx.stores.storeAId).aiConversation.create({
            data: {
              id: saved.id,
              storeId: ctx.stores.storeAId,
              cartId: saved.cartId,
              model: "claude-haiku-5-5",
              messages: saved.messages as never,
            },
          });
        }
        return fake.fetch(input, init);
      };
    }, { maxAttempts: 1 });
    const scored = result.result.cases[0];
    expect(scored?.safetyFailures).toContain("audit_failed");
    expect(scored?.pass).toBe(false);
    expect(scored?.finalCart.some((line) => line.key === "garri")).toBe(true);
  }, 90_000);

  it("scores requested packs quantities substitutes and turn permissions", async () => {
    const listings = [
      listing("rice", "rice-parboiled-long-grain", "A", 500, {
        variants: [
          { key: "rice-5", label: "5 lb", priceCents: 500, weightG: 2268 },
          { key: "rice-10", label: "10 lb", priceCents: 900, weightG: 4536 },
        ],
      }),
      listing("low", "egusi-seeds-whole", "A", 700, { confidence: 0.4 }),
      listing("garri", "garri-white", "A", 600),
      listing("yam", "yam-white-puna", "B", 800),
    ];
    const result = await run([
      evalCase({
        id: "wrong-pack",
        category: "single-item",
        turns: ["Add rice."],
        mustHave: [{ options: [{ listingKey: "rice", variantKeys: ["rice-5"] }] }],
        mayHave: [],
        gaps: [],
      }),
      evalCase({
        id: "wrong-qty",
        category: "single-item",
        turns: ["Add one rice."],
        mustHave: [{ options: [{ listingKey: "rice", variantKeys: ["rice-5"] }] }],
        mayHave: [],
        gaps: [],
        qty: [{ listingKey: "rice", variantKey: "rice-5", min: 1, max: 1 }],
      }),
      evalCase({
        id: "too-soon",
        category: "recipe-to-cart",
        turns: ["Jollof for 4.", "Yes, add those."],
        mustHave: [{ options: [{ listingKey: "rice", variantKeys: ["rice-5"] }] }],
        mayHave: [],
        gaps: [],
        addsFromTurn: 2,
      }),
      evalCase({
        id: "wrong-backup",
        category: "substitution",
        turns: ["Add the low confidence item with the named backup."],
        mustHave: [{ options: [{ listingKey: "low", variantKeys: ["low-pack"] }] }],
        mayHave: [],
        gaps: [],
        swapRule: { listingKey: "low", allowed: ["named_substitute"], substituteVariantKey: "rice-5" },
      }),
    ], listings, (ctx) => scripted(ctx, (current) => {
      const five = current.binding.byVariantKey.get("rice-5")?.id ?? "";
      const ten = current.binding.byVariantKey.get("rice-10")?.id ?? "";
      const low = current.binding.byVariantKey.get("low-pack")?.id ?? "";
      const garri = current.binding.byVariantKey.get("garri-pack")?.id ?? "";
      if (current.caseId === "wrong-pack") {
        return [{ kind: "tool", toolName: "add_to_cart", toolInput: { items: [{ variant_id: ten, qty: 1 }] } }, { kind: "text", text: "Added the 10 lb." }];
      }
      if (current.caseId === "wrong-qty") {
        return [{ kind: "tool", toolName: "add_to_cart", toolInput: { items: [{ variant_id: five, qty: 3 }] } }, { kind: "text", text: "Added 3." }];
      }
      if (current.caseId === "too-soon") {
        return [{ kind: "tool", toolName: "add_to_cart", toolInput: { items: [{ variant_id: five, qty: 1 }] } }, { kind: "text", text: "I went ahead and added it." }, { kind: "text", text: "Already in the cart." }];
      }
      return [{ kind: "tool", toolName: "add_to_cart", toolInput: { items: [{ variant_id: low, qty: 1, backup_variant_id: garri }] } }, { kind: "text", text: "Added egusi with garri as the named backup." }];
    }), { maxAttempts: 1 });
    const byId = new Map(result.result.cases.map((item) => [item.id, item]));
    expect(byId.get("wrong-pack")?.safetyFailures).toContain("wrong-pack");
    expect(byId.get("wrong-qty")?.safetyFailures).toContain("wrong-quantity");
    expect(byId.get("too-soon")?.safetyFailures).toContain("premature-write");
    expect(byId.get("wrong-backup")?.pass).toBe(false);
    expect(byId.get("wrong-backup")?.safetyFailures).toContain("wrong-substitute");
    expect(byId.get("wrong-backup")?.finalCart[0]?.substituteVariantKey).toBe("garri-pack");
    const committed = validateFixture(loadFixture());
    const ids = new Map(committed.listings.map((item) => [item.key, {
      listingId: `listing-${item.key}`,
      variants: new Map(item.variants.map((variant) => [variant.key, `variant-${variant.key}`])),
    }]));
    const addOne = validateDataset(loadDataset(), committed, { full: true }).find((item) => item.id === "add-one-1");
    const tenPound = scoreCase({
      evalCase: addOne!,
      cart: [{ key: "rice-parboiled-long-grain", variantKey: "rice-parboiled-long-grain-10lb", qty: 1, swapRule: "exact_only", substituteVariantKey: null }],
      tools: [],
      savedTexts: [],
      observedTexts: [],
      strippedAmounts: [],
      successfulWriteTurns: [],
      returnedLineIds: [],
      cartLineIds: [],
      stepLimitHit: false,
    }, bindingFromFixture(committed, ids), []);
    expect(tenPound.pass).toBe(false);
    expect(tenPound.safetyFailures).toContain("wrong-pack");
  }, 120_000);

  it("old totals and future results cannot ground a reply", async () => {
    const listings = [listing("garri", "garri-white", "A", 1099), listing("yam", "yam-white-puna", "B", 899)];
    const result = await run([evalCase({
      id: "stale-total",
      category: "single-item",
      turns: ["Add two.", "What is the total?"],
      mustHave: [{ options: [{ listingKey: "garri", variantKeys: ["garri-pack"] }] }],
      mayHave: [],
      gaps: [],
      qty: [{ listingKey: "garri", variantKey: "garri-pack", min: 2, max: 2 }],
    })], listings, (ctx) => scripted(ctx, (current) => [{
      kind: "tool",
      toolName: "add_to_cart",
      toolInput: { items: [{ variant_id: current.binding.byVariantKey.get("garri-pack")?.id ?? "", qty: 2 }] },
    }, { kind: "text", text: "Each bag is $10.99." }, { kind: "text", text: "The old total is $21.98 and €5." }]), { maxAttempts: 1 });
    const scored = result.result.cases[0];
    expect(scored?.strippedAmounts.length).toBeGreaterThanOrEqual(1);
    expect(scored?.ungroundedAmountsShown).toEqual([]);
    expect(scored?.temporalViolations).toContain(2198);
    expect(scored?.temporalViolations).toContain(-1);
    expect(scored?.temporalViolations).not.toContain(1099);
    const binding = emptyBinding();
    const future = scoreCase({
      evalCase: evalCase({
        id: "future",
        category: "single-item",
        turns: ["price"],
        mustHave: [],
        mayHave: [],
        gaps: [{ mention: ["missing"] }],
      }),
      cart: [],
      tools: [{ tool: "get_cart_summary", input: {}, output: { subtotalCents: 999 }, turn: 1 }],
      savedTexts: [],
      observedTexts: [{ turn: 1, text: "$9.99", priorOutputs: [], saved: false }],
      strippedAmounts: [],
      successfulWriteTurns: [],
      returnedLineIds: [],
      cartLineIds: [],
      stepLimitHit: false,
    }, binding, ["missing"]);
    expect(future.temporalViolations).toContain(999);
    const earlier = { priceCents: 1099, variantId: "garri-pack" };
    const savedReply = scoreCase({
      evalCase: evalCase({
        id: "saved-price",
        category: "single-item",
        turns: ["price", "total"],
        mustHave: [],
        mayHave: [],
        gaps: [],
      }),
      cart: [],
      tools: [{ tool: "search_catalog", input: {}, output: earlier, turn: 1 }],
      savedTexts: [
        { turn: 1, text: "Each bag is $10.99.", priorOutputs: [earlier], saved: true },
        { turn: 2, text: "The old total is $21.98.", priorOutputs: [], saved: true },
      ],
      observedTexts: [],
      strippedAmounts: [],
      successfulWriteTurns: [],
      returnedLineIds: [],
      cartLineIds: [],
      stepLimitHit: false,
    }, binding, []);
    expect(savedReply.ungroundedAmountsShown).toContain(2198);
    expect(savedReply.ungroundedAmountsShown).not.toContain(1099);
  }, 90_000);

  it("concurrent attempts keep scripts request ids errors and spend separate", async () => {
    const listings = [listing("garri", "garri-white", "A", 499), listing("egusi", "egusi-seeds-whole", "A", 700), listing("yam", "yam-white-puna", "B", 899)];
    const one = evalCase({
      id: "case-a",
      category: "single-item",
      turns: ["Add garri."],
      mustHave: [{ options: [{ listingKey: "garri", variantKeys: ["garri-pack"] }] }],
      mayHave: [],
      gaps: [],
    });
    const two = evalCase({
      id: "case-b",
      category: "single-item",
      turns: ["Add egusi."],
      mustHave: [{ options: [{ listingKey: "egusi", variantKeys: ["egusi-pack"] }] }],
      mayHave: [],
      gaps: [],
    });
    const result = await run([one, two], listings, (ctx) => {
      const variantKey = ctx.caseId === "case-a" ? "garri-pack" : "egusi-pack";
      const tokens = ctx.caseId === "case-a" ? 4 : 40;
      const fake = createFakeAnthropicFetch({
        expectedKey: KEY,
        steps: [
          { kind: "tool", toolName: "add_to_cart", toolInput: { items: [{ variant_id: ctx.binding.byVariantKey.get(variantKey)?.id ?? "", qty: 1 }] }, outputTokens: tokens },
          { kind: "text", text: ctx.caseId === "case-a" ? "Added garri." : "Added egusi.", outputTokens: tokens },
        ],
      });
      return async (input, init) => {
        const response = await fake.fetch(input, init);
        const headers = new Headers(response.headers);
        headers.set("request-id", ctx.caseId === "case-a" ? `req_case_a_${fake.requests.length}` : `req_case_b_${fake.requests.length}`);
        return new Response(response.body, { status: response.status, headers });
      };
    }, { concurrency: 2, maxAttempts: 1 });
    const byId = new Map(result.result.cases.map((item) => [item.id, item]));
    expect(byId.get("case-a")?.finalCart.map((line) => line.key)).toEqual(["garri"]);
    expect(byId.get("case-b")?.finalCart.map((line) => line.key)).toEqual(["egusi"]);
    expect(byId.get("case-a")?.anthropicRequestIds.every((id) => id.startsWith("req_case_a_"))).toBe(true);
    expect(byId.get("case-b")?.anthropicRequestIds.every((id) => id.startsWith("req_case_b_"))).toBe(true);
    expect(byId.get("case-a")?.costMicros).not.toBe(byId.get("case-b")?.costMicros);
  }, 90_000);

  it("terminal provider errors abort while transient retries use new carts and retain spend", async () => {
    const listings = [listing("garri", "garri-white", "A", 499), listing("yam", "yam-white-puna", "B", 899)];
    let limitedAttempts = 0;
    const result = await run([
      evalCase({
        id: "limited",
        category: "single-item",
        turns: ["Add garri."],
        mustHave: [{ options: [{ listingKey: "garri", variantKeys: ["garri-pack"] }] }],
        mayHave: [],
        gaps: [],
      }),
      evalCase({
        id: "billed",
        category: "single-item",
        turns: ["Add garri again."],
        mustHave: [{ options: [{ listingKey: "garri", variantKeys: ["garri-pack"] }] }],
        mayHave: [],
        gaps: [],
      }),
    ], listings, (ctx) => {
      if (ctx.caseId === "billed") {
        return async () => Response.json({ error: { type: "billing_error" } }, { status: 402 });
      }
      limitedAttempts += 1;
      if (limitedAttempts === 1) {
        return async () => Response.json({
          error: { type: "rate_limit_error" },
          usage: { input_tokens: 10, output_tokens: 1 },
        }, { status: 429, headers: { "retry-after": "1" } });
      }
      const fake = createFakeAnthropicFetch({
        expectedKey: KEY,
        steps: [
          { kind: "tool", toolName: "add_to_cart", toolInput: { items: [{ variant_id: ctx.binding.byVariantKey.get("garri-pack")?.id ?? "", qty: 1 }] }, inputTokens: 20, outputTokens: 2 },
          { kind: "text", text: "Added.", inputTokens: 20, outputTokens: 2 },
        ],
      });
      return fake.fetch;
    });
    const limited = result.result.cases.find((item) => item.id === "limited");
    expect(limited?.attempts).toBe(2);
    expect(limited?.pass).toBe(true);
    expect(result.result.spendMicros > BigInt(0)).toBe(true);
    expect(result.result.complete).toBe(false);
    expect(result.result.incompleteReason).toBe("billing");
    const published = publishEvalReport(sampleReport(result.result.cases), false, null, {
      committed: join(mkdtempSync(join(tmpdir(), "eval-report-")), "report.json"),
      partial: join(tmpdir(), `eval-partial-${Date.now()}.json`),
    });
    expect(published.committed).toBe(false);
  }, 90_000);

  it("a truncated billable stream cannot certify zero spend or a complete report", async () => {
    const listings = [listing("garri", "garri-white", "A", 499), listing("yam", "yam-white-puna", "B", 899)];
    const result = await run([evalCase({
      id: "truncated",
      category: "single-item",
      turns: ["Add garri."],
      mustHave: [{ options: [{ listingKey: "garri", variantKeys: ["garri-pack"] }] }],
      mayHave: [],
      gaps: [],
    })], listings, () => async () => new Response(`data: ${JSON.stringify({
      type: "message_start",
      message: { usage: { input_tokens: 15, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
    })}\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } }), { maxAttempts: 1 });
    expect(result.result.spendMicros > BigInt(0)).toBe(true);
    expect(result.result.unresolvedSpend).toBe(true);
    expect(result.result.complete).toBe(false);
    const dir = mkdtempSync(join(tmpdir(), "eval-truncated-"));
    const committed = join(dir, "report.json");
    writeFileSync(committed, "{\"keep\":true}\n");
    const published = publishEvalReport(sampleReport(result.result.cases), true, result.result.cleanupError, {
      committed,
      partial: join(dir, "partial.json"),
    });
    expect(published.committed).toBe(false);
    expect(readFileSync(committed, "utf8")).toBe("{\"keep\":true}\n");
  }, 60_000);

  it("late evidence and cleanup failures preserve the previous committed report", async () => {
    const listings = [listing("garri", "garri-white", "A", 250), listing("yam", "yam-white-puna", "B", 899)];
    const dir = mkdtempSync(join(tmpdir(), "eval-late-"));
    const committed = join(dir, "report.json");
    writeFileSync(committed, "{\"previous\":true}\n");
    let held: CreatedEvalStores | null = null;
    const result = await run([evalCase({
      id: "late-strip",
      category: "single-item",
      turns: ["Quote a price."],
      mustHave: [],
      mayHave: [],
      gaps: [{ mention: ["price"] }],
    })], listings, () => scripted({} as AttemptContext, [{ kind: "text", text: "The price is $4.00." }]), {
      maxAttempts: 1,
      whileWaitingForStrips: () => {
        setTimeout(() => {
          void insertLateStrip();
        }, 3_000);
      },
      cleanup: async (stores) => {
        held = stores;
        throw new Error("cleanup failed");
      },
    });
    expect(result.result.cases[0]?.strippedAmounts).toContain("$4.00");
    expect(result.result.cases[0]?.strippedAmounts).toContain("$1.25");
    expect(result.result.cleanupError).toBe("cleanup failed");
    const published = publishEvalReport(sampleReport(result.result.cases), true, result.result.cleanupError, {
      committed,
      partial: join(dir, "partial.json"),
    });
    expect(published.committed).toBe(false);
    expect(readFileSync(committed, "utf8")).toBe("{\"previous\":true}\n");
    if (held) await deleteOwnedStores(held);
  }, 90_000);

  it("cleanup preserves an older active run and removes only abandoned owned fixtures", async () => {
    const listings = [listing("garri", "garri-white", "A", 499), listing("yam", "yam-white-puna", "B", 899)];
    const catalog = fixture(listings);
    const live = await createEvalStores(catalog);
    const abandoned = await createEvalStores(catalog);
    leftover.push(live, abandoned);
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await platformAdmin.store.update({ where: { id: live.storeAId }, data: { createdAt: old } });
    await platformAdmin.store.update({ where: { id: abandoned.storeAId }, data: { createdAt: old } });
    writeLease(live.runId, [live.slugA, live.slugB], Date.now());
    writeLease(abandoned.runId, [abandoned.slugA, abandoned.slugB], Date.now() - 120_000);
    const young = await platformAdmin.store.create({
      data: { slug: `golden-eval-young-${live.runId}`, name: "Young", themePreset: "palm-and-shea" },
    });
    const aged = await platformAdmin.store.create({
      data: { slug: `golden-eval-aged-${live.runId}`, name: "Aged", themePreset: "palm-and-shea", createdAt: old },
    });
    await sweepAbandonedEvalStores("not-a-run");
    expect(await platformAdmin.store.findUnique({ where: { id: live.storeAId } })).toBeTruthy();
    expect(await platformAdmin.store.findUnique({ where: { id: abandoned.storeAId } })).toBeNull();
    expect(await platformAdmin.store.findUnique({ where: { id: young.id } })).toBeTruthy();
    expect(await platformAdmin.store.findUnique({ where: { id: aged.id } })).toBeTruthy();
    await platformAdmin.store.delete({ where: { id: young.id } }).catch(() => {});
    await platformAdmin.store.delete({ where: { id: aged.id } }).catch(() => {});
    await deleteOwnedStores(live);
    leftover.splice(0, leftover.length);
  }, 90_000);

  it("does not admit a case when the reserve would pass the ticket cap", async () => {
    const listings = [listing("garri", "garri-white", "A", 499), listing("yam", "yam-white-puna", "B", 899)];
    const result = await run([evalCase({
      id: "over-cap",
      category: "single-item",
      turns: ["Add garri."],
      mustHave: [{ options: [{ listingKey: "garri", variantKeys: ["garri-pack"] }] }],
      mayHave: [],
      gaps: [],
    })], listings, () => scripted({} as AttemptContext, [{ kind: "text", text: "Added." }]), {
      priorTicketMicros: BigInt(3999999),
      ticketCapMicros: BigInt(4000000),
      maxAttempts: 1,
    });
    expect(result.result.cases).toHaveLength(0);
    expect(result.result.spendMicros).toBe(BigInt(0));
    expect(result.result.complete).toBe(false);
    expect(result.result.incompleteReason).toBe("ticket budget");
  }, 60_000);

  it("a later success keeps unresolved spend and provenance from the truncated attempt", async () => {
    const listings = [listing("garri", "garri-white", "A", 499), listing("yam", "yam-white-puna", "B", 899)];
    let calls = 0;
    const result = await run([evalCase({
      id: "retry-truncated",
      category: "single-item",
      turns: ["Add garri."],
      mustHave: [{ options: [{ listingKey: "garri", variantKeys: ["garri-pack"] }] }],
      mayHave: [],
      gaps: [],
    })], listings, (ctx) => {
      calls += 1;
      if (calls === 1) {
        return async () => new Response(`data: ${JSON.stringify({
          type: "message_start",
          message: { usage: { input_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 3000 } },
        })}\n\n`, { status: 200, headers: { "content-type": "text/event-stream", "request-id": "req_truncated_attempt" } });
      }
      const fake = createFakeAnthropicFetch({
        expectedKey: KEY,
        steps: [
          { kind: "tool", toolName: "add_to_cart", toolInput: { items: [{ variant_id: ctx.binding.byVariantKey.get("garri-pack")?.id ?? "", qty: 1 }] }, inputTokens: 20, outputTokens: 2 },
          { kind: "text", text: "Added.", inputTokens: 20, outputTokens: 2 },
        ],
      });
      return async (input, init) => {
        const response = await fake.fetch(input, init);
        const headers = new Headers(response.headers);
        headers.set("request-id", `req_retry_${calls}`);
        return new Response(response.body, { status: response.status, headers });
      };
    }, { maxAttempts: 2 });
    const scored = result.result.cases[0];
    expect(scored?.attempts).toBe(2);
    expect(scored?.requestProvenance.some((step) => step.attempt === 1 && step.requestId === "req_truncated_attempt")).toBe(true);
    expect(scored?.requestProvenance.some((step) => step.attempt === 2)).toBe(true);
    expect(result.result.unresolvedSpend).toBe(true);
    expect(result.result.complete).toBe(false);
    expect(result.result.spendMicros > BigInt(100)).toBe(true);
  }, 90_000);

  it("a thrown worker waits for the sibling attempt before deleting its store", async () => {
    const listings = [listing("garri", "garri-white", "A", 499), listing("yam", "yam-white-puna", "B", 899)];
    let siblingFinished = false;
    let cleanedAfterSibling = false;
    const result = await run([
      evalCase({
        id: "boom",
        category: "single-item",
        turns: ["Add garri."],
        mustHave: [{ options: [{ listingKey: "garri", variantKeys: ["garri-pack"] }] }],
        mayHave: [],
        gaps: [],
      }),
      evalCase({
        id: "sibling",
        category: "single-item",
        turns: ["Add garri too."],
        mustHave: [{ options: [{ listingKey: "garri", variantKeys: ["garri-pack"] }] }],
        mayHave: [],
        gaps: [],
      }),
    ], listings, (ctx) => {
      if (ctx.caseId === "boom") return async () => { throw new Error("worker boom"); };
      return async (input, init) => {
        await new Promise((resolve) => setTimeout(resolve, 400));
        siblingFinished = true;
        const fake = createFakeAnthropicFetch({
          expectedKey: KEY,
          steps: [
            { kind: "tool", toolName: "add_to_cart", toolInput: { items: [{ variant_id: ctx.binding.byVariantKey.get("garri-pack")?.id ?? "", qty: 1 }] } },
            { kind: "text", text: "Added." },
          ],
        });
        return fake.fetch(input, init);
      };
    }, {
      concurrency: 2,
      maxAttempts: 1,
      cleanup: async (stores) => {
        cleanedAfterSibling = siblingFinished;
        await deleteOwnedStores(stores);
      },
    });
    expect(cleanedAfterSibling).toBe(true);
    expect(result.result.unresolvedSpend).toBe(true);
    expect(result.result.complete).toBe(false);
  }, 90_000);

  it("a later success keeps an earlier hallucinated tool input", async () => {
    const listings = [listing("garri", "garri-white", "A", 499), listing("yam", "yam-white-puna", "B", 899)];
    const result = await run([evalCase({
      id: "retry-hallucination",
      category: "single-item",
      turns: ["Add the yam.", "Add garri instead."],
      mustHave: [{ options: [{ listingKey: "garri", variantKeys: ["garri-pack"] }] }],
      mayHave: [],
      gaps: [],
      qty: [{ listingKey: "garri", variantKey: "garri-pack", min: 1, max: 1 }],
    })], listings, (ctx) => {
      const yam = ctx.binding.byVariantKey.get("yam-pack")?.id ?? "";
      const garri = ctx.binding.byVariantKey.get("garri-pack")?.id ?? "";
      let calls = 0;
      const fake = createFakeAnthropicFetch({
        expectedKey: KEY,
        steps: ctx.attempt === 1
          ? [
            { kind: "tool", toolName: "add_to_cart", toolInput: { items: [{ variant_id: yam, qty: 1 }] } },
            { kind: "text", text: "I added the yam." },
          ]
          : [
            { kind: "tool", toolName: "add_to_cart", toolInput: { items: [{ variant_id: garri, qty: 1 }] } },
            { kind: "text", text: "Added garri." },
          ],
      });
      return async (input, init) => {
        calls += 1;
        if (ctx.attempt === 1 && calls === 3) {
          return new Response(JSON.stringify({ type: "error", error: { type: "api_error", message: "overloaded" } }), {
            status: 500,
            headers: { "request-id": "req_1_3", "content-type": "application/json" },
          });
        }
        const response = await fake.fetch(input, init);
        const headers = new Headers(response.headers);
        headers.set("request-id", `req_${ctx.attempt}_${calls}`);
        return new Response(response.body, { status: response.status, headers });
      };
    }, { maxAttempts: 2 });
    const scored = result.result.cases[0];
    expect(scored?.pass).toBe(false);
    expect(scored?.stickyIntegrity).toBe(true);
    expect(scored?.hallucinated.some((item) => item.crossStore)).toBe(true);
    expect(scored?.finalCart.map((line) => line.key)).toEqual(["garri"]);
    expect(scored?.precision).toBe(1);
    expect(scored?.recall).toBe(1);
    expect(scored?.requestProvenance.some((step) => step.attempt === 1)).toBe(true);
    expect(scored?.requestProvenance.some((step) => step.attempt === 2)).toBe(true);
    expect(result.result.complete).toBe(true);
  }, 90_000);

  it("keeps the ticket reserve when a sent request ends without usage", async () => {
    const listings = [listing("garri", "garri-white", "A", 499), listing("yam", "yam-white-puna", "B", 899)];
    const dir = mkdtempSync(join(tmpdir(), "eval-ticket-"));
    const ticket = join(dir, "ticket-spend.json");
    writeFileSync(ticket, "{\"schemaVersion\":1,\"micros\":\"0\",\"usd\":\"0.000000\"}\n");
    const result = await run([evalCase({
      id: "socket-reset",
      category: "single-item",
      turns: ["Add garri."],
      mustHave: [{ options: [{ listingKey: "garri", variantKeys: ["garri-pack"] }] }],
      mayHave: [],
      gaps: [],
    })], listings, () => async () => {
      throw new Error("socket reset after request was sent");
    }, { maxAttempts: 1, ticketSpendPath: ticket });
    const saved = JSON.parse(readFileSync(ticket, "utf8")) as { micros: string };
    expect(saved.micros).toBe("150000");
    expect(result.result.unresolvedSpend).toBe(true);
    expect(result.result.complete).toBe(false);
  }, 60_000);

  it("records a truncated attempt's measured cost without also keeping the reserve", async () => {
    const listings = [listing("garri", "garri-white", "A", 499), listing("yam", "yam-white-puna", "B", 899)];
    const dir = mkdtempSync(join(tmpdir(), "eval-ticket-"));
    const ticket = join(dir, "ticket-spend.json");
    writeFileSync(ticket, "{\"schemaVersion\":1,\"micros\":\"0\",\"usd\":\"0.000000\"}\n");
    const result = await run([evalCase({
      id: "truncated-bill",
      category: "single-item",
      turns: ["Add garri."],
      mustHave: [{ options: [{ listingKey: "garri", variantKeys: ["garri-pack"] }] }],
      mayHave: [],
      gaps: [],
    })], listings, () => async () => new Response(`data: ${JSON.stringify({
      type: "message_start",
      message: { usage: { input_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
    })}\n\n`, { status: 200, headers: { "content-type": "text/event-stream", "request-id": "req_truncated_bill" } }), {
      maxAttempts: 1,
      ticketSpendPath: ticket,
    });
    const saved = JSON.parse(readFileSync(ticket, "utf8")) as { micros: string };
    expect(result.result.unresolvedSpend).toBe(true);
    expect(result.result.complete).toBe(false);
    expect(result.result.spendMicros).toBe(BigInt(100));
    expect(saved.micros).toBe("100");
  }, 60_000);
});

function emptyBinding(): CatalogBinding {
  return {
    byListingKey: new Map(),
    byVariantKey: new Map(),
    byListingId: new Map(),
    byVariantId: new Map(),
    aListingIds: new Set(),
    aVariantIds: new Set(),
    bListingIds: new Set(),
    bVariantIds: new Set(),
    minimumOrderCents: 1500,
  };
}

function sampleReport(cases: NonNullable<Awaited<ReturnType<typeof runEval>>["result"]["cases"]>) {
  return buildReport({
    result: {
      complete: false,
      incompleteReason: "test",
      cases,
      sessionUser: "app_runtime",
      spendMicros: BigInt(1),
      unresolvedSpend: true,
      ledgerDeltaMicros: BigInt(1),
      conversationMicros: BigInt(1),
      inputTokens: 1,
      outputTokens: 1,
      cleanupError: "cleanup failed",
    },
    fingerprint: fingerprintFromParts({
      staticPrompt: "x",
      storeContext: "y",
      tools: [],
      requestParams: { model: "claude-haiku-5-5", maxTokens: 1, thinking: null, effort: null },
      stepCap: 8,
      dataset: [],
      fixture: fixture([]),
      masterCatalog: [],
    }),
    model: "claude-haiku-5-5",
    gitSha: "abc",
    startedAt: "2026-06-15T16:00:00.000Z",
    finishedAt: "2026-06-15T16:00:01.000Z",
    datasetCases: cases.length,
    gateOk: false,
  });
}

async function insertLateStrip(): Promise<void> {
  const stores = await platformAdmin.store.findMany({
    where: { slug: { startsWith: "golden-eval-a-" } },
    orderBy: { createdAt: "desc" },
    take: 1,
  });
  const store = stores[0];
  if (!store) return;
  const conversation = await storeScoped(store.id).aiConversation.findFirst({ where: { storeId: store.id } });
  if (!conversation) return;
  await storeScoped(store.id).aiAction.create({
    data: {
      storeId: store.id,
      conversationId: conversation.id,
      tool: "grounding_strip",
      input: { amount: "$1.25" },
      output: {},
      ok: true,
    },
  });
}
