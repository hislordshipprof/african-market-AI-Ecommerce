import { takeRateLimit } from "../rate-limit/app-limiter";
import { readGeocodeCache, writeGeocodeCache } from "./cache";
import { addressCacheKey, assessRadius, type AddressParts, type Geocode, type StorePoint, type Suggestion } from "./geo";
import { getAddressProvider } from "./provider";

const CONFIRM_LIMIT = 20;
const CONFIRM_WINDOW_MS = 10 * 60 * 1000;
const SUGGEST_IP_LIMIT = 30;
const SUGGEST_PLATFORM_LIMIT = 600;
const SUGGEST_WINDOW_MS = 60 * 1000;

export type DeliveryDecision =
  | {
      ok: true;
      match: Geocode;
      distanceMi: number;
      roundedMi: number;
      withinRadius: boolean;
    }
  | {
      ok: false;
      code: "no-match" | "ambiguous" | "unavailable" | "rejected" | "rate-limited";
      message: string;
    };

function messageFor(code: Exclude<DeliveryDecision, { ok: true }>["code"]): string {
  if (code === "ambiguous") return "Add your ZIP code so we can find the exact address.";
  if (code === "unavailable") return "We couldn't check that address right now. Try again.";
  if (code === "rate-limited") return "Try again shortly.";
  return "We couldn't find that address";
}

function decide(match: Geocode, store: StorePoint): DeliveryDecision {
  const radius = assessRadius(match, store);
  return { ok: true, match, ...radius };
}

/** Quote and payment read this. No Census call and no rate limit. */
export async function lookupConfirmed(
  parts: AddressParts,
  store: StorePoint,
  now = new Date(),
): Promise<DeliveryDecision | null> {
  const cached = await readGeocodeCache(parts, now);
  if (!cached) return null;
  return decide(cached, store);
}

/**
 * Confirm calls Census only on a cache miss, and only when `limit` is true
 * (the Confirm action). Quote must not use this.
 */
export async function confirmDeliveryAddress(
  parts: AddressParts,
  store: StorePoint,
  options: { limit: boolean; ip?: string; now?: Date },
): Promise<DeliveryDecision> {
  const now = options.now ?? new Date();
  const cached = await lookupConfirmed(parts, store, now);
  if (cached) return cached;
  if (options.limit) {
    const limit = await takeRateLimit(
      `address:confirm:${options.ip || "unknown"}`,
      CONFIRM_LIMIT,
      CONFIRM_WINDOW_MS,
      now.getTime(),
    );
    if (!limit.ok) return { ok: false, code: "rate-limited", message: messageFor("rate-limited") };
  }
  const located = await getAddressProvider().locate(parts);
  if (!located.ok) return { ok: false, code: located.code, message: messageFor(located.code) };
  await writeGeocodeCache(parts, located.match, now);
  const matched = {
    line1: located.match.line1,
    city: located.match.city,
    state: located.match.state,
    zip: located.match.zip,
  };
  if (addressCacheKey(parts) !== addressCacheKey(matched)) {
    await writeGeocodeCache(matched, located.match, now);
  }
  return decide(located.match, store);
}

export async function suggestDeliveryAddresses(
  query: string,
  store: StorePoint,
  ip: string,
): Promise<Suggestion[]> {
  const trimmed = query.trim();
  if (trimmed.length < 3) return [];
  const [ipLimit, platformLimit] = await Promise.all([
    takeRateLimit(`address:suggest:${ip}`, SUGGEST_IP_LIMIT, SUGGEST_WINDOW_MS),
    takeRateLimit("address:suggest:platform", SUGGEST_PLATFORM_LIMIT, SUGGEST_WINDOW_MS),
  ]);
  if (!ipLimit.ok || !platformLimit.ok) return [];
  try {
    return await getAddressProvider().suggest(trimmed, store);
  } catch {
    return [];
  }
}
