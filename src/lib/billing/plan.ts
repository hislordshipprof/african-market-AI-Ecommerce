import { storeScoped } from "../db";

/**
 * The one place that answers "may this store use feature X" (ADR-0021 "Plan features").
 * Every gate calls this module; never compare plan names anywhere else.
 */
export type Plan = "starter" | "pro";

export type PlanFeature =
  | "own-domain"
  | "courier-delivery"
  | "copilot-reports"
  | "whatsapp"
  | "analytics-dashboard";

export const PRO_FEATURES: readonly PlanFeature[] = [
  "own-domain",
  "courier-delivery",
  "copilot-reports",
  "whatsapp",
  "analytics-dashboard",
];

export const FEATURE_LABELS: Record<PlanFeature, string> = {
  "own-domain": "Your own domain",
  "courier-delivery": "Courier delivery",
  "copilot-reports": "Voice and photo stock reports",
  whatsapp: "WhatsApp for copilot and alerts",
  "analytics-dashboard": "Analytics dashboard",
};

export const PLAN_PRICES_USD: Record<Plan, number> = { starter: 49, pro: 99 };

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
}

export function effectivePlan(row: SubscriptionPlanRow | null | undefined): Plan {
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

/** Store-admin link a locked feature points to. */
export function upgradeHref(storeSlug: string): string {
  return `/store-admin/plan?store=${encodeURIComponent(storeSlug)}`;
}

export async function storePlan(storeId: string): Promise<Plan> {
  const row = await storeScoped(storeId).storeSubscription.findUnique({
    where: { storeId },
    select: { plan: true, status: true },
  });
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
