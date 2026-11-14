import { money } from "@/lib/format";

/** Whether the basket may go to checkout, and what to tell the shopper when it may not. */
export function minimumOrderGate(
  subtotalCents: number,
  minimumCents: number,
): { met: boolean; message: string | null } {
  const minimum = Math.max(0, minimumCents);
  if (subtotalCents >= minimum) return { met: true, message: null };
  return { met: false, message: minimumOrderMessage(minimum - subtotalCents, minimum) };
}

/** The one wording for a basket under the store minimum, wherever it shows. */
export function minimumOrderMessage(missingCents: number, minimumCents: number): string {
  return `${money(missingCents)} more to reach the ${money(minimumCents)} minimum`;
}
