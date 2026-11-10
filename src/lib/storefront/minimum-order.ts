import { money } from "@/lib/format";

/** Whether the basket may go to checkout, and what to tell the shopper when it may not. */
export function minimumOrderGate(
  subtotalCents: number,
  minimumCents: number,
): { met: boolean; message: string | null } {
  const minimum = Math.max(0, minimumCents);
  if (subtotalCents >= minimum) return { met: true, message: null };
  return {
    met: false,
    message: `${money(minimum - subtotalCents)} more to reach the ${money(minimum)} minimum`,
  };
}
