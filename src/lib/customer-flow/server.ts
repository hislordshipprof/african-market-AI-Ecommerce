import "server-only";
import { cache } from "react";
import { getStore } from "@/lib/get-store";
import { getFlowCatalog } from "@/lib/storefront/service";
import { demoFlowsEnabled } from "./demo-gate";
import type { FlowStore } from "./contracts";

export const getFlowContext = cache(async () => {
  const store = await getStore();
  const enabled = demoFlowsEnabled(process.env);
  // Addresses, driver configuration and opening-time calculation land in later tickets.
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
    storeDeliveryEnabled: store.storeDeliveryEnabled
      && store.lat != null
      && store.lng != null
      && Number(store.deliveryRadiusMi) > 0,
    deliveryRadiusMi: Number(store.deliveryRadiusMi),
    prepTimeMinutes: store.prepTimeMinutes,
    storeDeliveryFeeCents: store.storeDeliveryFeeCents,
    autoRefundLimitCents: store.autoRefundLimitCents,
    insulatedPackaging: store.slug === "mama-ngozi",
    closed: false,
    opensAt: "9:00 AM",
  };
  return {
    store,
    settings,
    catalog: await getFlowCatalog(store.id),
    enabled,
  };
});
