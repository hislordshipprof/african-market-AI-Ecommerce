import type { Allergen, DietaryClaim } from "../../catalog/attributes";

export const EVAL_CATEGORIES = [
  "recipe-to-cart",
  "single-item",
  "multi-item",
  "synonym",
  "out-of-stock",
  "ambiguous-quantity",
  "substitution",
  "constraint",
  "helpful-extras",
] as const;

export type EvalCategory = (typeof EVAL_CATEGORIES)[number];

export const CATEGORY_COUNTS: Record<EvalCategory, number> = {
  "recipe-to-cart": 40,
  "single-item": 35,
  "multi-item": 30,
  synonym: 30,
  "out-of-stock": 25,
  "ambiguous-quantity": 20,
  substitution: 20,
  constraint: 6,
  "helpful-extras": 5,
};

export const SWAP_RULES = ["exact_only", "store_suggests", "named_substitute"] as const;
export type SwapRuleName = (typeof SWAP_RULES)[number];

export interface PackRef {
  listingKey: string;
  variantKeys: string[];
}

export interface MustGroup {
  options: PackRef[];
}

export interface GapExpect {
  key?: string;
  mention: string[];
}

export interface QtyExpect {
  listingKey: string;
  variantKey: string;
  min: number;
  max: number;
}

export interface SwapExpect {
  listingKey: string;
  allowed: SwapRuleName[];
  substituteVariantKey?: string;
}

/** A placed order seeded before the case: the signed-in shopper's own, or another customer's at the same store. */
export interface PastOrder {
  store: "A" | "B";
  customer: "self" | "other";
  lines: Array<{ listingKey: string; variantKey: string; qty: number }>;
}

/** A dish-only request: no shopper list, so the case passes or fails on core items, not item counts. */
export interface DishExpect {
  /** Each core ingredient is met by any store A listing in options, at any pack or quantity. */
  core: Array<{ label: string; options: string[] }>;
  /** Servings are not given, so the first reply must ask or state them. */
  askServings: boolean;
}

export interface EvalCase {
  id: string;
  category: EvalCategory;
  turns: string[];
  mustHave: MustGroup[];
  mayHave: PackRef[];
  gaps: GapExpect[];
  qty?: QtyExpect[];
  swapRule?: SwapExpect;
  addsFromTurn?: number;
  /** Listings the shopper ruled out. One in the cart is a safety failure. */
  excluded?: string[];
  dish?: DishExpect;
  /** The shopper is signed in and has these orders ("my usual"). */
  pastOrders?: PastOrder[];
}

export interface FixtureVariant {
  key: string;
  label: string;
  priceCents: number;
  weightG: number;
}

export interface FixtureListing {
  key: string;
  masterProductId: string;
  priceCents: number;
  stockMode: "unlimited" | "counted" | "status";
  qty: number | null;
  status: string | null;
  confidence: number;
  active: boolean;
  maxPerOrder: number | null;
  variants: FixtureVariant[];
  /** A listings are the eval store. B listings are the decoy store. */
  store: "A" | "B";
  /** Stated by the store owner, so known. A listing without attributes is unknown. */
  attributes?: { ingredients: string[]; allergens: Allergen[]; dietary: DietaryClaim[] };
}

export interface CatalogFixture {
  schemaVersion: 1;
  pinnedNow: string;
  store: {
    name: string;
    timezone: string;
    hours: Record<string, { open: string; close: string }>;
    minimumOrderCents: number;
    pickupEnabled: boolean;
  };
  /** Ingredient names and synonyms the listings' attributes use. */
  ingredients?: Array<{ name: string; synonyms: string[] }>;
  listings: FixtureListing[];
}

export interface HallucinatedItem {
  tool: string;
  field: string;
  id: string;
  crossStore: boolean;
}

export interface CartSnapshotLine {
  key: string;
  variantKey: string;
  qty: number;
  swapRule: string;
  substituteVariantKey: string | null;
}

export interface CaseResult {
  id: string;
  category: EvalCategory;
  pass: boolean;
  /** True only when the final attempt was scored and all its spend is known. A failed score can still be complete. */
  completed: boolean;
  reason: string;
  attempts: number;
  precision: number;
  recall: number;
  precisionNumerator: number;
  precisionDenominator: number;
  recallNumerator: number;
  recallDenominator: number;
  hallucinated: HallucinatedItem[];
  /** Made-up ids a tool refused that never reached the cart or a reply; counted, not a failure (owner, 2026-11-11). */
  rejectedAttempts: HallucinatedItem[];
  strippedAmounts: string[];
  ungroundedAmountsShown: number[];
  temporalViolations: number[];
  gapsReported: boolean;
  safetyFailures: string[];
  stickyIntegrity: boolean;
  finalCart: CartSnapshotLine[];
  steps: number;
  stepLimitHit: boolean;
  toolInputErrors: number;
  quantityChecks: number;
  quantityHits: number;
  gapRequired: boolean;
  /** True for a dish-only case, which is scored pass or fail and stays out of the item-level counts. */
  dish: boolean;
  dishMisses: string[];
  /** The final reply when it was an accepted clarifying question; the gate re-checks it. */
  clarifyReply: string | null;
  /** Listing keys that accepted question offered, and the choice-card names it showed; the gate re-checks both. */
  clarifyOptions: string[];
  clarifyChoices: string[];
  /** True when set_shopper_needs had saved needs; the gate re-scores with it. */
  savedNeeds: boolean;
  /** Attempts ended by a request whose usage never arrived; their reserve stays spent. A completed case never ends on one. */
  droppedAttempts: number;
  costMicros: string;
  anthropicRequestIds: string[];
  requestProvenance: Array<{ attempt: number; turn: number; step: number; requestId: string }>;
}

export interface RunResult {
  complete: boolean;
  incompleteReason: string | null;
  cases: CaseResult[];
  sessionUser: string;
  spendMicros: bigint;
  /** Measured cost of streams cut before their final usage; the app's ledger never sees it. */
  droppedMicros: bigint;
  unresolvedSpend: boolean;
  ledgerDeltaMicros: bigint | null;
  conversationMicros: bigint;
  inputTokens: number;
  outputTokens: number;
  cleanupError: string | null;
}
