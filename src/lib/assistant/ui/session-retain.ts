export type SessionIdentity = {
  storeId: string;
  accountId: string | null;
  cartId: string | null;
};

export type RetainInput = SessionIdentity & { loading: boolean };

/** Whether a navigation may keep the chat that is already open for this store. */
export function retainAction(
  existing: SessionIdentity | null,
  input: RetainInput,
): "keep" | "adopt" | "reset" | "create" {
  if (!existing || existing.storeId !== input.storeId) return "create";
  if (existing.accountId !== input.accountId) {
    const signingOut = existing.accountId != null && input.accountId == null;
    const switching = existing.accountId != null && input.accountId != null;
    if (signingOut || switching) return "reset";
    const sameCart = existing.cartId != null && existing.cartId === input.cartId;
    const pendingClaim = input.loading && existing.cartId != null && input.cartId == null;
    if (sameCart) return "adopt";
    if (pendingClaim) return "keep";
    return "reset";
  }
  if (input.loading) return "keep";
  const sameCart = existing.cartId === input.cartId;
  const firstCart = existing.cartId == null && input.cartId != null;
  if (sameCart || firstCart) return firstCart ? "adopt" : "keep";
  return "reset";
}
