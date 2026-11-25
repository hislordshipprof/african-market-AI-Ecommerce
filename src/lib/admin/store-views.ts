import { BILLING_STATUSES, type Plan } from "../billing/plan";

/** The saved views on the Stores page (#859), as tabs. */
export const STORE_VIEWS = [
  { value: "all", label: "All" },
  { value: "live", label: "Live" },
  { value: "setup", label: "In setup" },
  { value: "payment-failed", label: "Payment failed" },
  { value: "suspended", label: "Suspended" },
] as const;
export type StoreView = (typeof STORE_VIEWS)[number]["value"];

const PLANS: readonly Plan[] = ["starter", "pro"];
const PILOT = ["yes", "no"] as const;
const SEARCH_MAX = 100;

export type ListedStore = {
  id: string;
  name: string;
  slug: string;
  status: string;
  plan: Plan;
  metroId: string | null;
  subscription: { status: string; pilot: boolean; paymentFailedAt: Date | null } | null;
};

/** Empty string means no filter. `metro` is a metro id, or "none" for stores in no metro. */
export type StoreFilters = { view: StoreView; q: string; metro: string; plan: "" | Plan; billing: string; pilot: "" | (typeof PILOT)[number] };

const IN_VIEW: Record<StoreView, (store: ListedStore) => boolean> = {
  all: () => true,
  live: (store) => store.status === "active",
  setup: (store) => store.status === "setup",
  "payment-failed": (store) => !!store.subscription?.paymentFailedAt,
  suspended: (store) => store.status === "suspended",
};

export function storeViewCounts(stores: ListedStore[]): Record<StoreView, number> {
  return Object.fromEntries(STORE_VIEWS.map(({ value }) => [value, stores.filter(IN_VIEW[value]).length])) as Record<StoreView, number>;
}

export function filterStores<T extends ListedStore>(stores: T[], filters: StoreFilters): T[] {
  const q = filters.q.toLowerCase();
  return stores.filter((store) =>
    IN_VIEW[filters.view](store)
    && (!q || store.name.toLowerCase().includes(q) || store.slug.toLowerCase().includes(q))
    && (!filters.metro || (filters.metro === "none" ? store.metroId === null : store.metroId === filters.metro))
    && (!filters.plan || store.plan === filters.plan)
    && (!filters.billing || (store.subscription?.status ?? "none") === filters.billing)
    && (!filters.pilot || (store.subscription?.pilot ?? false) === (filters.pilot === "yes")),
  );
}

/** The page's search params, each checked against its fixed list (metros against the ids that exist). */
export function parseStoreFilters(params: Record<string, string | string[] | undefined>, metroIds: readonly string[]): StoreFilters {
  const one = (name: string) => (typeof params[name] === "string" ? (params[name] as string) : "");
  const pick = <V extends string>(value: string, allowed: readonly V[]): V | "" => ((allowed as readonly string[]).includes(value) ? (value as V) : "");
  return {
    view: pick(one("view"), STORE_VIEWS.map((view) => view.value)) || "all",
    q: one("q").trim().slice(0, SEARCH_MAX),
    metro: pick(one("metro"), [...metroIds, "none"]),
    plan: pick(one("plan"), PLANS),
    billing: pick(one("billing"), BILLING_STATUSES),
    pilot: pick(one("pilot"), PILOT),
  };
}
