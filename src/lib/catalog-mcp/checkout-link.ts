import { applyAddLine } from "../cart/service";
import { CHECKOUT_LINK_TTL_MS, checkoutLinkPath, createCheckoutLink } from "../cart/checkout-link";
import { lockCart, storeScopedTransaction } from "../db";
import { AGENT_REF } from "../directory/attribution";
import { takeRateLimit } from "../rate-limit/app-limiter";

const LINKS_PER_HOUR = 10;
const HOUR_MS = 60 * 60 * 1000;

export interface CheckoutLinkItem {
  variant_id: string;
  qty: number;
}

export type CheckoutLinkOutcome =
  | {
      ok: true;
      checkoutUrl: string;
      expiresAt: Date;
      items: Array<{ variantId: string; qty: number; priceCents: number }>;
      subtotalCents: number;
    }
  | { ok: false; message: string };

class Refused extends Error {}

/**
 * A new guest cart at this store with these variants, and a single-use link to the store's own checkout (#573).
 * All or nothing: one unknown, other-store or hidden variant, or one over its per-order maximum, builds no cart.
 * Nothing is reserved and no payment is started; the shopper pays on the checkout the link opens.
 */
export async function createAgentCheckoutLink(
  storeId: string,
  origin: string,
  ip: string,
  items: CheckoutLinkItem[],
): Promise<CheckoutLinkOutcome> {
  // Per IP across every store host; a refused call counts too.
  const limit = await takeRateLimit(`mcp:checkout-link:ip:${ip}`, LINKS_PER_HOUR, HOUR_MS);
  if (!limit.ok) {
    return { ok: false, message: `Too many checkout links from this address. Try again in ${Math.ceil(limit.retryAfter / 60)} minutes.` };
  }

  const now = new Date();
  try {
    return await storeScopedTransaction(storeId, async (tx) => {
      const cart = await tx.cart.create({ data: { storeId, userId: null, customerId: null, source: AGENT_REF } });
      await lockCart(tx, cart.id);
      const lines = new Map<string, { qty: number; priceCents: number }>();
      for (const item of items) {
        const applied = await applyAddLine(tx, storeId, cart.id, item.variant_id, item.qty, { requireActive: true });
        if (!applied.ok && applied.code === "max_per_order") {
          throw new Refused(applied.stockLeft !== undefined
            ? `Only ${applied.stockLeft} of variant ${item.variant_id} left.`
            : `At most ${applied.maxPerOrder} of variant ${item.variant_id} per order.`);
        }
        if (!applied.ok) {
          throw new Refused(`No product variant ${item.variant_id} in this store. Use a variant id that get_product returned.`);
        }
        lines.set(applied.variant.id, { qty: applied.qty, priceCents: applied.variant.price });
      }
      const token = await createCheckoutLink(storeId, cart.id, now, tx);
      const listed = [...lines].map(([variantId, line]) => ({ variantId, ...line }));
      return {
        ok: true as const,
        checkoutUrl: new URL(checkoutLinkPath(token), origin).toString(),
        expiresAt: new Date(now.getTime() + CHECKOUT_LINK_TTL_MS),
        items: listed,
        subtotalCents: listed.reduce((sum, line) => sum + line.priceCents * line.qty, 0),
      };
    });
  } catch (error) {
    if (error instanceof Refused) return { ok: false, message: error.message };
    throw error;
  }
}
