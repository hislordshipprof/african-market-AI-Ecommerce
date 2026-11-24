import { deliveryProofBucket } from "../r2";

/**
 * The store offers its own delivery: switched on, a radius, a pickup point to measure it from, and the proof bucket,
 * without which the delivered photo has nowhere to be kept and the order could never be marked delivered (#765, #775).
 */
export function storeDeliveryOffered<T extends { storeDeliveryEnabled: boolean; deliveryRadiusMi: unknown; lat: number | null; lng: number | null }>(
  store: T,
  env: Record<string, string | undefined> = process.env,
): store is T & { lat: number; lng: number } {
  return store.storeDeliveryEnabled && Number(store.deliveryRadiusMi) > 0 && store.lat != null && store.lng != null && deliveryProofBucket(env) !== null;
}
