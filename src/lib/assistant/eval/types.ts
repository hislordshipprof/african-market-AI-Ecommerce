export const EVAL_CATEGORIES = [
  "recipe-to-cart",
  "single-item",
  "multi-item",
  "synonym",
  "out-of-stock",
  "ambiguous-quantity",
  "substitution",
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
  unresolvedSpend: boolean;
  ledgerDeltaMicros: bigint | null;
  conversationMicros: bigint;
  inputTokens: number;
  outputTokens: number;
  cleanupError: string | null;
}
