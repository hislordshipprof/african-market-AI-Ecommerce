import { money } from "@/lib/format";
import type { ServiceFeeSettings } from "@/lib/order/platform-fee";

const COURIER = "Courier fees are the courier's quote, with no markup.";

/** The shopper fee note on the directory home (#863), from the platform's service fee settings (ADR-0021, ADR-0006). */
export function feeNote({ rateBps, minCents, maxCents }: ServiceFeeSettings): string {
  if (rateBps <= 0) return `Prices are the market's own. Any delivery fee shows before you pay. ${COURIER}`;
  const rate = `${rateBps / 100}%`;
  return `Prices are the market's own. A service fee of ${rate} of your goods, from ${money(minCents)} to ${money(maxCents)}, and any delivery fee show before you pay. ${COURIER}`;
}
