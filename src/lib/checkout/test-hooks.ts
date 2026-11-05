import type { CartWithLines } from "../cart/service";

/**
 * Test-only pauses. Production leaves every hook null. Each hook runs only
 * when NODE_ENV is test, so a leaked hook cannot stall a live checkout.
 */
export const checkoutTestHooks: {
  afterMissedOrderLookup: (() => Promise<void>) | null;
  aroundCartRead: ((read: () => Promise<CartWithLines | null>) => Promise<CartWithLines | null>) | null;
  afterPostReadLookupMiss: (() => Promise<void>) | null;
  beforePersistCartPaymentIntent: (() => Promise<void>) | null;
  beforeCancelPaymentIntent: (() => Promise<void>) | null;
} = {
  afterMissedOrderLookup: null,
  aroundCartRead: null,
  afterPostReadLookupMiss: null,
  beforePersistCartPaymentIntent: null,
  beforeCancelPaymentIntent: null,
};
