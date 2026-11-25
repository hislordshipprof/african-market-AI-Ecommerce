import "server-only";
import { cache } from "react";
import { getStore } from "@/lib/get-store";
import { getFlowCatalog } from "@/lib/storefront/service";
import { describeQueue, storeAvailability } from "@/lib/order/store-queue";
import { demoFlowsEnabled } from "./demo-gate";
import { storeMayUse } from "@/lib/billing/plan";
import { courierOffered } from "@/lib/delivery/courier-offered";
import { anyCourierEnabled, readStoreCourierSettings } from "@/lib/delivery/courier-settings";
import { storeShipsTo } from "@/lib/shipping/eligibility";
import { readShippingStates, shippingReady } from "@/lib/shipping/settings";
import { storeDeliveryOffered } from "@/lib/delivery/store-delivery-offered";
import { activeDeliveryPause, pauseEndLabel } from "@/lib/delivery/delivery-pause";
import type { FlowStore } from "./contracts";

export const getFlowContext = cache(async () => {
  const store = await getStore();
  const enabled = demoFlowsEnabled(process.env);
  // Computed per request, never baked into a page cached by store tag (ADR-0012).
  const now = new Date();
  const availability = storeAvailability(store.hours, store.timezone, now);
  // The owner's delivery pause (#819) hides store and courier delivery; checkout refuses them server-side too.
  const pausedUntil = activeDeliveryPause(store, now);
  const queue =
    availability.kind === "queued"
      ? describeQueue(availability.clockStartsAt, store.prepTimeMinutes, store.timezone)
      : null;
  // Addresses and driver configuration land in later tickets.
  // These explicitly labelled fixtures never run behind the production gate.
  const settings: FlowStore = {
    id: store.id,
    slug: store.slug,
    name: store.name,
    address: [store.addressLine1, store.city, store.state, store.zip].filter(Boolean).join(", ")
      || store.neighborhood
      || "this market",
    minimumOrderCents: store.minimumOrderCents,
    pickupEnabled: store.pickupEnabled,
    // Store delivery and Ship are offered only when their orders can be completed (#765).
    storeDeliveryEnabled: !pausedUntil && storeDeliveryOffered(store),
    deliveryRadiusMi: Number(store.deliveryRadiusMi),
    prepTimeMinutes: store.prepTimeMinutes,
    storeDeliveryFeeCents: store.storeDeliveryFeeCents,
    autoRefundLimitCents: store.autoRefundLimitCents,
    insulatedPackaging: store.slug === "mama-ngozi",
    courierOffered: !pausedUntil
      && courierOffered(store)
      && (await storeMayUse(store.id, "courier-delivery"))
      && anyCourierEnabled(await readStoreCourierSettings(store.id), store.id),
    shipsTo: shippingReady() ? storeShipsTo(store.shippingHandlingDays, await readShippingStates()) : [],
    closed: availability.kind === "queued",
    opensAt: queue?.opensAt ?? "",
    readyAt: queue?.readyAt ?? "",
    takingOrders: availability.kind !== "unavailable",
    deliveryPausedUntil: pausedUntil ? pauseEndLabel(pausedUntil, store.timezone, now) : "",
  };
  return {
    store,
    settings,
    catalog: await getFlowCatalog(store.id),
    enabled,
  };
});
