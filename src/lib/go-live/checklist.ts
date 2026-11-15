import { platform, storeScopedTransaction } from "../db";
import { readAiOnboardingSettings } from "../admin/ai-onboarding-settings";
import { getStoreBilling } from "../billing/service";
import { planAllows } from "../billing/plan";
import { courierOffered } from "../delivery/courier-offered";
import { isValidTimezone, nextOpening } from "../order/store-hours";

/** The go-live checklist (#555, spec §6.1 step 6). Every item is required; a test order is recommended, never a gate. */
export const GO_LIVE_ITEM_KEYS = ["payouts", "hours", "fulfillment", "listings", "weights", "plan", "couriers"] as const;
export type GoLiveItemKey = (typeof GO_LIVE_ITEM_KEYS)[number];

export interface GoLiveItem {
  key: GoLiveItemKey;
  done: boolean;
  /** One short line on where the item stands. */
  detail: string;
}

export interface GoLiveChecklist {
  /** The store's status when read: `setup`, `active` or `suspended`. */
  status: string;
  items: GoLiveItem[];
  ready: boolean;
  /** Active listings with a price needed, from AI and onboarding settings (#561). */
  floor: number;
}

export function goLiveItemLabel(key: GoLiveItemKey, floor: number): string {
  switch (key) {
    case "payouts": return "Payouts connected";
    case "hours": return "Hours and time zone set";
    case "fulfillment": return "Pickup or a delivery option on";
    case "listings": return `At least ${floor} active listings with a price`;
    case "weights": return "No placeholder weights on active listings";
    case "plan": return "Plan chosen";
    case "couriers": return "Courier registration";
  }
}

/** An active listing shows a price above zero: its own price, or every pack's price when it has packs. */
const PRICED = {
  active: true,
  OR: [
    { variants: { none: {} }, price: { gt: 0 } },
    { variants: { some: {}, none: { price: { lte: 0 } } } },
  ],
};

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** Read fresh for every render and every Go live: the store row, its listings, its billing and the floor setting. */
export async function readGoLiveChecklist(storeId: string, now: Date): Promise<GoLiveChecklist | null> {
  const store = await platform.store.findUnique({ where: { id: storeId } });
  if (!store) return null;
  const [{ goLiveListingFloor: floor }, billing, [priced, needWeight]] = await Promise.all([
    readAiOnboardingSettings(),
    getStoreBilling(storeId),
    storeScopedTransaction(storeId, async (tx) => [
      await tx.listing.count({ where: { storeId, ...PRICED } }),
      await tx.listing.count({ where: { storeId, active: true, variants: { some: { weightPlaceholder: true } } } }),
    ] as const),
  ]);

  // No hours at all means "always open" to checkout, so the checklist asks for a real weekly schedule.
  const weekly = typeof store.hours === "object" && store.hours !== null && !Array.isArray(store.hours);
  const hoursSet = weekly && isValidTimezone(store.timezone) && nextOpening(store.hours, store.timezone, now) !== null;
  const storeDelivery = store.storeDeliveryEnabled && store.lat != null && store.lng != null && Number(store.deliveryRadiusMi) > 0;
  const courierNeeded = planAllows(billing.plan, "courier-delivery");
  const courierRegistered = Boolean(store.uberLocationId || store.doordashStoreId);
  const courier = courierNeeded && courierOffered(store);
  const planChosen = billing.subscribed || billing.pilot;

  const items: GoLiveItem[] = [
    {
      key: "payouts",
      done: store.stripeOnboardingStatus === "complete",
      detail: store.stripeOnboardingStatus === "complete" ? "Stripe can pay you out" : "Finish Stripe setup to take payments",
    },
    { key: "hours", done: hoursSet, detail: hoursSet ? `${store.timezone.replace("America/", "").replaceAll("_", " ")} time` : "Opening hours are not set" },
    {
      key: "fulfillment",
      done: store.pickupEnabled || storeDelivery || courier,
      detail: [store.pickupEnabled && "Pickup", storeDelivery && "Store delivery", courier && "Courier delivery"].filter(Boolean).join(", ") || "Nothing is on yet",
    },
    { key: "listings", done: priced >= floor, detail: `${priced} of ${floor}` },
    { key: "weights", done: needWeight === 0, detail: needWeight === 0 ? "Every active listing has a weight" : `${plural(needWeight, "listing needs", "listings need")} a weight` },
    {
      key: "plan",
      done: planChosen,
      detail: billing.pilot ? "Pilot store" : billing.subscribed ? `${billing.plan === "pro" ? "Pro" : "Starter"} plan` : "Choose Starter or Pro",
    },
    {
      key: "couriers",
      done: !courierNeeded || courierRegistered,
      detail: !courierNeeded ? "Not needed on Starter" : courierRegistered ? "Registered" : "Waiting for the platform team to register the store",
    },
  ];
  return { status: store.status, items, ready: items.every((i) => i.done), floor };
}
