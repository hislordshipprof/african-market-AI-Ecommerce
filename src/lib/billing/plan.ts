import { readStorePlanRows, storeScopedTransaction } from "../db";

/**
 * The one place that answers "may this store use feature X" (ADR-0021 "Plan features").
 * Every gate calls this module; never compare plan names anywhere else.
 */
export type Plan = "starter" | "pro";

export type PlanFeature =
  | "own-domain"
  | "courier-delivery"
  | "copilot-reports"
  | "reorder-suggestions"
  | "whatsapp"
  | "analytics-dashboard"
  | "store-assistant";

export const PRO_FEATURES: readonly PlanFeature[] = [
  "own-domain",
  "courier-delivery",
  "copilot-reports",
  "reorder-suggestions",
  "whatsapp",
  "analytics-dashboard",
  "store-assistant",
];

export const FEATURE_LABELS: Record<PlanFeature, string> = {
  "own-domain": "Your own domain",
  "courier-delivery": "Courier delivery",
  "copilot-reports": "Voice and photo stock reports",
  "reorder-suggestions": "Reorder suggestions",
  whatsapp: "WhatsApp for copilot and alerts",
  "analytics-dashboard": "Analytics dashboard",
  "store-assistant": "Store assistant (AI chat)",
};

/** Sold on the plan page but not built yet; every place that lists a feature marks these "coming soon". */
const NOT_LIVE_FEATURES: ReadonlySet<PlanFeature> = new Set(["own-domain", "whatsapp", "analytics-dashboard"]);

export function featureLive(feature: PlanFeature): boolean {
  return !NOT_LIVE_FEATURES.has(feature);
}

export const PLAN_PRICES_USD: Record<Plan, number> = { starter: 49, pro: 99 };

export const PLAN_NAMES: Record<Plan, string> = { starter: "Starter", pro: "Pro" };

/** Stripe subscription status as owners and admins read it; "none" is a store that never subscribed. */
const BILLING_STATUS_LABELS: Record<string, string> = {
  none: "Not subscribed",
  trialing: "Free trial",
  active: "Active",
  past_due: "Payment failed",
  unpaid: "Unpaid",
  canceled: "Cancelled",
  incomplete: "Waiting for card",
  incomplete_expired: "Not started",
  paused: "Paused",
};

/** Every status a store's billing can show, "none" first. */
export const BILLING_STATUSES = Object.keys(BILLING_STATUS_LABELS);

export function billingStatusLabel(status: string): string {
  return BILLING_STATUS_LABELS[status] ?? status;
}

/** The plan the plan picker highlights. */
export const RECOMMENDED_PLAN: Plan = "pro";

const ASSISTANT_CHATS: Record<Plan, number> = { starter: 1_000, pro: 5_000 };
/** Staff besides the owner. Null is unlimited. */
const STAFF_LIMIT: Record<Plan, number | null> = { starter: 2, pro: null };
const SUPPORT: Record<Plan, string> = {
  starter: "Email, next business day",
  pro: "Priority, same day",
};

/** Stripe statuses that keep Pro features: a failed payment never switches a store off without an admin decision. */
const PRO_STATUSES = new Set(["trialing", "active", "past_due"]);

export interface SubscriptionPlanRow {
  plan: string;
  status: string;
  /** A running platform override only (`readStorePlanRows` drops it once it ends). */
  overridePlan?: string | null;
}

function isPlan(value: string | null | undefined): value is Plan {
  return value === "starter" || value === "pro";
}

/** A running override wins over Stripe, downgrade included; after it ends the Stripe plan applies (#547). */
export function effectivePlan(row: SubscriptionPlanRow | null | undefined): Plan {
  if (isPlan(row?.overridePlan)) return row.overridePlan;
  return row?.plan === "pro" && PRO_STATUSES.has(row.status) ? "pro" : "starter";
}

export function planAllows(plan: Plan, feature: PlanFeature): boolean {
  return plan === "pro" || !PRO_FEATURES.includes(feature);
}

export function assistantChatCap(plan: Plan): number {
  return ASSISTANT_CHATS[plan];
}

/** The owner is warned once the month reaches this many chats. */
export function assistantChatWarnAt(plan: Plan): number {
  return Math.floor(ASSISTANT_CHATS[plan] * 0.8);
}

export function staffLimit(plan: Plan): number | null {
  return STAFF_LIMIT[plan];
}

export function supportLevel(plan: Plan): string {
  return SUPPORT[plan];
}

/** One row of the Starter vs Pro comparison: true or false is included or not, a string is that plan's own value. */
export interface PlanComparisonRow {
  label: string;
  starter: boolean | string;
  pro: boolean | string;
  comingSoon?: boolean;
}

export const PLANS: readonly Plan[] = ["starter", "pro"];

function perPlan(value: (plan: Plan) => boolean | string): Pick<PlanComparisonRow, Plan> {
  return { starter: value("starter"), pro: value("pro") };
}

/**
 * The one list of what each plan gives (#838): /sell and the store-admin plan page both render it,
 * so no other page keeps its own list of features.
 */
export function planComparisonRows(): PlanComparisonRow[] {
  return [
    { label: "Branded store, catalog, orders, refunds and payouts", ...perPlan(() => true) },
    { label: "Allergy and diet rules, swap or refund prompts", ...perPlan(() => true) },
    { label: "Pickup and your own delivery", ...perPlan(() => true) },
    { label: "Shopping-assistant chats a month", ...perPlan((plan) => assistantChatCap(plan).toLocaleString("en-US")) },
    {
      label: "Staff",
      ...perPlan((plan) => {
        const staff = staffLimit(plan);
        return staff === null ? "Unlimited staff" : `Owner + ${staff} staff`;
      }),
    },
    { label: "Support", ...perPlan(supportLevel) },
    ...PRO_FEATURES.map((feature) => ({
      label: FEATURE_LABELS[feature],
      ...perPlan((plan) => planAllows(plan, feature)),
      ...(featureLive(feature) ? {} : { comingSoon: true }),
    })),
  ];
}

export async function storePlan(storeId: string): Promise<Plan> {
  const [row] = await storeScopedTransaction(storeId, (tx) => readStorePlanRows(tx, [storeId]));
  return effectivePlan(row);
}

export async function storeMayUse(storeId: string, feature: PlanFeature): Promise<boolean> {
  return planAllows(await storePlan(storeId), feature);
}

/**
 * Staff past the plan limit keep read-only access (ADR-0021 downgrade rule).
 * The earliest staff keep write access; owners are never limited.
 */
export function readOnlyStaffIds(
  plan: Plan,
  members: readonly { userId: string; role: string; createdAt: Date }[],
): Set<string> {
  const limit = staffLimit(plan);
  if (limit === null) return new Set();
  const staff = members
    .filter((m) => m.role !== "owner")
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.userId.localeCompare(b.userId));
  return new Set(staff.slice(limit).map((m) => m.userId));
}
