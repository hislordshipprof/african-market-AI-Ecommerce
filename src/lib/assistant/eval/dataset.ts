import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CATEGORY_COUNTS,
  EVAL_CATEGORIES,
  SWAP_RULES,
  type CatalogFixture,
  type EvalCase,
  type EvalCategory,
  type MustGroup,
  type PackRef,
  type PastOrder,
} from "./types";

export const DATASET_PATH = join(process.cwd(), "src/lib/assistant/eval/dataset.json");
export const FIXTURE_PATH = join(process.cwd(), "src/lib/assistant/eval/catalog.json");
export const REPORT_PATH = join(process.cwd(), "src/lib/assistant/eval/report.json");
export const PARTIAL_REPORT_PATH = join(process.cwd(), "src/lib/assistant/eval/partial-report.json");
export const TICKET_SPEND_PATH = join(process.cwd(), "src/lib/assistant/eval/ticket-spend.json");

export function loadDataset(path = DATASET_PATH): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

export function loadFixture(path = FIXTURE_PATH): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

export function validateDataset(
  raw: unknown,
  fixture: CatalogFixture,
  options: { full: boolean; allowOverlap?: boolean },
): EvalCase[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("Eval dataset is empty.");
  }
  const cases = raw.map((item, index) => parseCase(item, index));
  const ids = new Set<string>();
  for (const item of cases) {
    if (ids.has(item.id)) throw new Error(`Duplicate eval case id ${item.id}.`);
    ids.add(item.id);
    assertKeys(item, fixture, options.allowOverlap === true);
  }
  if (options.full) {
    const total = Object.values(CATEGORY_COUNTS).reduce((sum, count) => sum + count, 0);
    if (cases.length !== total) throw new Error(`Eval dataset has ${cases.length} cases, not ${total}.`);
    for (const category of EVAL_CATEGORIES) {
      const count = cases.filter((item) => item.category === category).length;
      if (count !== CATEGORY_COUNTS[category]) {
        throw new Error(`Eval dataset category ${category} has ${count}, not ${CATEGORY_COUNTS[category]}.`);
      }
    }
  }
  return cases;
}

function parseCase(raw: unknown, index: number): EvalCase {
  if (!raw || typeof raw !== "object") throw new Error(`Eval case ${index} is not an object.`);
  const record = raw as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id : "";
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) throw new Error(`Eval case ${index} has an invalid id.`);
  if (!EVAL_CATEGORIES.includes(record.category as EvalCategory)) {
    throw new Error(`Eval case ${id} has an unknown category.`);
  }
  if (!Array.isArray(record.turns) || record.turns.length < 1 || record.turns.length > 3) {
    throw new Error(`Eval case ${id} must have 1 to 3 turns.`);
  }
  const turns = record.turns.map((turn) => {
    if (typeof turn !== "string" || turn.length < 1 || turn.length > 2000) {
      throw new Error(`Eval case ${id} has a turn outside 1 to 2000 characters.`);
    }
    return turn;
  });
  const mustHave = parseGroups(record.mustHave, id);
  const mayHave = parsePacks(record.mayHave, id);
  const gaps = parseGaps(record.gaps, id);
  const qty = parseQty(record.qty, id);
  const swapRule = parseSwap(record.swapRule, id);
  const excluded = parseExcluded(record.excluded, id);
  const dish = parseDish(record.dish, id);
  const pastOrders = parsePastOrders(record.pastOrders, id);
  if ((record.category === "recipe-to-cart") !== (dish != null)) {
    throw new Error(`Eval case ${id} must be a dish case exactly when it is recipe-to-cart.`);
  }
  if (dish && (mustHave.length > 0 || mayHave.length > 0 || qty.length > 0)) {
    throw new Error(`Eval case ${id} is a dish case and cannot fix a list, pack or quantity.`);
  }
  const addsFromTurn = record.addsFromTurn == null ? undefined : Number(record.addsFromTurn);
  if (addsFromTurn != null && (!Number.isInteger(addsFromTurn) || addsFromTurn < 1 || addsFromTurn > turns.length)) {
    throw new Error(`Eval case ${id} has an invalid addsFromTurn.`);
  }
  if (mustHave.length === 0 && gaps.length === 0 && addsFromTurn == null && !dish && !excluded?.length) {
    throw new Error(`Eval case ${id} is empty.`);
  }
  return {
    id,
    category: record.category as EvalCategory,
    turns,
    mustHave,
    mayHave,
    gaps,
    ...(qty.length > 0 ? { qty } : {}),
    ...(swapRule ? { swapRule } : {}),
    ...(addsFromTurn != null ? { addsFromTurn } : {}),
    ...(excluded.length > 0 ? { excluded } : {}),
    ...(dish ? { dish } : {}),
    ...(pastOrders.length > 0 ? { pastOrders } : {}),
  };
}

function parsePastOrders(raw: unknown, id: string): PastOrder[] {
  if (raw == null) return [];
  const malformed = () => new Error(`Eval case ${id} has a malformed past order.`);
  if (!Array.isArray(raw) || raw.length === 0) throw malformed();
  return raw.map((order) => {
    const record = (order ?? {}) as Record<string, unknown>;
    if ((record.store !== "A" && record.store !== "B") || (record.customer !== "self" && record.customer !== "other")
      || !Array.isArray(record.lines) || record.lines.length === 0) throw malformed();
    const lines = record.lines.map((line) => {
      const row = (line ?? {}) as Record<string, unknown>;
      if (typeof row.listingKey !== "string" || typeof row.variantKey !== "string" || !Number.isInteger(row.qty) || (row.qty as number) < 1) throw malformed();
      return { listingKey: row.listingKey, variantKey: row.variantKey, qty: row.qty as number };
    });
    return { store: record.store, customer: record.customer, lines };
  });
}

function parseExcluded(raw: unknown, id: string): string[] {
  if (raw == null) return [];
  if (!Array.isArray(raw) || raw.some((key) => typeof key !== "string" || key === "")) {
    throw new Error(`Eval case ${id} has a malformed excluded list.`);
  }
  return raw as string[];
}

function parseDish(raw: unknown, id: string): EvalCase["dish"] {
  if (raw == null) return undefined;
  const dish = raw as { core?: unknown; askServings?: unknown };
  if (!Array.isArray(dish.core) || dish.core.length === 0 || typeof dish.askServings !== "boolean") {
    throw new Error(`Eval case ${id} has a malformed dish.`);
  }
  const core = dish.core.map((group) => {
    const record = (group ?? {}) as { label?: unknown; options?: unknown };
    if (typeof record.label !== "string" || record.label === "" || !Array.isArray(record.options) || record.options.length === 0
      || record.options.some((key) => typeof key !== "string")) {
      throw new Error(`Eval case ${id} has a malformed dish core item.`);
    }
    return { label: record.label, options: record.options as string[] };
  });
  return { core, askServings: dish.askServings };
}

function parseGroups(raw: unknown, id: string): MustGroup[] {
  if (!Array.isArray(raw)) throw new Error(`Eval case ${id} is missing mustHave.`);
  return raw.map((group) => {
    if (!group || typeof group !== "object" || !Array.isArray((group as { options?: unknown }).options)) {
      throw new Error(`Eval case ${id} has a malformed mustHave group.`);
    }
    const options = parsePacks((group as { options: unknown }).options, id);
    if (options.length === 0) throw new Error(`Eval case ${id} has an empty mustHave group.`);
    return { options };
  });
}

function parsePacks(raw: unknown, id: string): PackRef[] {
  if (!Array.isArray(raw)) throw new Error(`Eval case ${id} has a malformed pack list.`);
  return raw.map((item) => {
    if (!item || typeof item !== "object") throw new Error(`Eval case ${id} has a malformed pack.`);
    const pack = item as { listingKey?: unknown; variantKeys?: unknown };
    if (typeof pack.listingKey !== "string" || !Array.isArray(pack.variantKeys) || pack.variantKeys.length === 0) {
      throw new Error(`Eval case ${id} has a pack without a listing and variant.`);
    }
    if (pack.variantKeys.some((key) => typeof key !== "string")) {
      throw new Error(`Eval case ${id} has a non-string variant key.`);
    }
    return { listingKey: pack.listingKey, variantKeys: pack.variantKeys as string[] };
  });
}

function parseGaps(raw: unknown, id: string): EvalCase["gaps"] {
  if (!Array.isArray(raw)) throw new Error(`Eval case ${id} is missing gaps.`);
  return raw.map((gap) => {
    if (!gap || typeof gap !== "object") throw new Error(`Eval case ${id} has a malformed gap.`);
    const record = gap as { key?: unknown; mention?: unknown };
    if (!Array.isArray(record.mention) || record.mention.length === 0 || record.mention.some((term) => typeof term !== "string" || term === "")) {
      throw new Error(`Eval case ${id} has a gap without mention terms.`);
    }
    return {
      ...(typeof record.key === "string" ? { key: record.key } : {}),
      mention: record.mention as string[],
    };
  });
}

function parseQty(raw: unknown, id: string): NonNullable<EvalCase["qty"]> {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new Error(`Eval case ${id} has a malformed qty.`);
  return raw.map((item) => {
    if (!item || typeof item !== "object") throw new Error(`Eval case ${id} has a malformed qty.`);
    const qty = item as { listingKey?: unknown; variantKey?: unknown; min?: unknown; max?: unknown };
    if (typeof qty.listingKey !== "string" || typeof qty.variantKey !== "string") {
      throw new Error(`Eval case ${id} has a qty without a variant.`);
    }
    if (typeof qty.min !== "number" || typeof qty.max !== "number" || !Number.isInteger(qty.min) || !Number.isInteger(qty.max) || qty.min < 1 || qty.max < qty.min) {
      throw new Error(`Eval case ${id} has a qty range that is not a positive integer span.`);
    }
    return { listingKey: qty.listingKey, variantKey: qty.variantKey, min: qty.min, max: qty.max };
  });
}

function parseSwap(raw: unknown, id: string): EvalCase["swapRule"] {
  if (raw == null) return undefined;
  if (!raw || typeof raw !== "object") throw new Error(`Eval case ${id} has a malformed swap rule.`);
  const swap = raw as { listingKey?: unknown; allowed?: unknown; substituteVariantKey?: unknown };
  if (typeof swap.listingKey !== "string" || !Array.isArray(swap.allowed) || swap.allowed.length === 0) {
    throw new Error(`Eval case ${id} has a swap rule without a listing.`);
  }
  if (swap.allowed.some((rule) => !SWAP_RULES.includes(rule as (typeof SWAP_RULES)[number]))) {
    throw new Error(`Eval case ${id} has an unknown swap rule.`);
  }
  return {
    listingKey: swap.listingKey,
    allowed: swap.allowed as NonNullable<EvalCase["swapRule"]>["allowed"],
    ...(typeof swap.substituteVariantKey === "string" ? { substituteVariantKey: swap.substituteVariantKey } : {}),
  };
}

function assertKeys(item: EvalCase, fixture: CatalogFixture, allowOverlap: boolean): void {
  const known = new Map(fixture.listings.map((listing) => [listing.key, listing]));
  const mustKeys: string[] = [];
  for (const group of item.mustHave) {
    for (const option of group.options) assertPack(item.id, option, known);
    const keys = group.options.map((option) => option.listingKey);
    mustKeys.push(...keys);
  }
  if (!allowOverlap) {
    const seen = new Set<string>();
    for (const key of mustKeys) {
      if (seen.has(key)) throw new Error(`Eval case ${item.id} repeats listing ${key} across mustHave groups.`);
      seen.add(key);
    }
  }
  for (const option of item.mayHave) assertPack(item.id, option, known);
  for (const key of item.excluded ?? []) {
    if (!known.has(key)) throw new Error(`Eval case ${item.id} excludes unknown listing ${key}.`);
    if (mustKeys.includes(key)) throw new Error(`Eval case ${item.id} both requires and excludes ${key}.`);
  }
  for (const group of item.dish?.core ?? []) {
    for (const key of group.options) {
      const listing = known.get(key);
      if (!listing || listing.store !== "A" || !listing.active) throw new Error(`Eval case ${item.id} has core item ${key} that store A does not sell.`);
      if (item.excluded?.includes(key)) throw new Error(`Eval case ${item.id} both requires and excludes ${key}.`);
    }
  }
  for (const order of item.pastOrders ?? []) {
    for (const line of order.lines) {
      const listing = known.get(line.listingKey);
      if (!listing || listing.store !== order.store || !listing.variants.some((variant) => variant.key === line.variantKey)) {
        throw new Error(`Eval case ${item.id} has a past order line ${line.variantKey} that store ${order.store} does not sell.`);
      }
    }
  }
  const gapKeys = new Set(item.gaps.flatMap((gap) => (gap.key ? [gap.key] : [])));
  for (const key of gapKeys) {
    if (!known.has(key)) throw new Error(`Eval case ${item.id} names unknown gap key ${key}.`);
    if (mustKeys.includes(key)) throw new Error(`Eval case ${item.id} puts ${key} in both mustHave and gaps.`);
  }
  for (const qty of item.qty ?? []) {
    const listing = known.get(qty.listingKey);
    if (!listing || !listing.variants.some((variant) => variant.key === qty.variantKey)) {
      throw new Error(`Eval case ${item.id} names unknown qty variant ${qty.variantKey}.`);
    }
  }
  if (item.swapRule) {
    const listing = known.get(item.swapRule.listingKey);
    if (!listing) throw new Error(`Eval case ${item.id} names unknown swap listing ${item.swapRule.listingKey}.`);
    if (item.swapRule.substituteVariantKey && !fixture.listings.some((row) => row.variants.some((variant) => variant.key === item.swapRule?.substituteVariantKey))) {
      throw new Error(`Eval case ${item.id} names an unknown substitute variant.`);
    }
  }
}

function assertPack(id: string, pack: PackRef, known: Map<string, CatalogFixture["listings"][number]>): void {
  const listing = known.get(pack.listingKey);
  if (!listing) throw new Error(`Eval case ${id} names unknown listing ${pack.listingKey}.`);
  for (const variantKey of pack.variantKeys) {
    if (!listing.variants.some((variant) => variant.key === variantKey)) {
      throw new Error(`Eval case ${id} names unknown variant ${variantKey}.`);
    }
  }
}

export function validateFixture(raw: unknown): CatalogFixture {
  if (!raw || typeof raw !== "object") throw new Error("Eval catalog fixture is missing.");
  const fixture = raw as CatalogFixture;
  if (fixture.schemaVersion !== 1) throw new Error("Eval catalog fixture schema is not 1.");
  if (!fixture.store || fixture.store.timezone === "UTC") throw new Error("Eval store timezone must not be UTC.");
  if (!Number.isInteger(fixture.store.minimumOrderCents) || fixture.store.minimumOrderCents < 0) {
    throw new Error("Eval store minimum must be integer cents.");
  }
  if (!Array.isArray(fixture.listings) || fixture.listings.length < 2) {
    throw new Error("Eval catalog fixture needs listings.");
  }
  const keys = new Set<string>();
  for (const listing of fixture.listings) {
    if (keys.has(listing.key)) throw new Error(`Duplicate fixture listing ${listing.key}.`);
    keys.add(listing.key);
    if (listing.variants.length === 0) throw new Error(`Fixture listing ${listing.key} has no variants.`);
    if (!Number.isInteger(listing.priceCents)) throw new Error(`Fixture listing ${listing.key} price is not integer cents.`);
    const variantKeys = new Set<string>();
    for (const variant of listing.variants) {
      if (variantKeys.has(variant.key)) throw new Error(`Duplicate variant ${variant.key}.`);
      variantKeys.add(variant.key);
      if (!Number.isInteger(variant.priceCents) || variant.weightG <= 0) {
        throw new Error(`Variant ${variant.key} needs integer cents and a positive weight.`);
      }
    }
  }
  const storeA = fixture.listings.filter((listing) => listing.store === "A").length;
  const storeB = fixture.listings.filter((listing) => listing.store === "B").length;
  if (fixture.listings.length > 20 && (storeA < 60 || storeA > 80 || storeB < 8)) {
    throw new Error("The committed catalog needs 60 to 80 store A listings and about 10 decoy listings.");
  }
  return fixture;
}
