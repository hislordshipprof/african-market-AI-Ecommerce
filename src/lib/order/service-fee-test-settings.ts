import type { ServiceFeeSettings } from "./platform-fee";

/** Tests only: the platform settings row as the #495 migration seeds it. */
export const SEEDED_SERVICE_FEE: ServiceFeeSettings = { rateBps: 300, minCents: 99, maxCents: 299 };
