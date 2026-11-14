/**
 * Courier delivery needs the store registered with a courier, a pickup point to measure the radius from, and a phone:
 * Uber Direct will not book a pickup without one. The plan gate (storeMayUse "courier-delivery") is checked by callers.
 */
export function courierOffered(store: { uberLocationId: string | null; doordashStoreId: string | null; addressLine1: string | null; city: string | null; state: string | null; zip: string | null; lat: number | null; lng: number | null; phone: string | null }): boolean {
  return Boolean((store.uberLocationId || store.doordashStoreId) && store.addressLine1 && store.city && store.state && store.zip && store.lat != null && store.lng != null && store.phone);
}
