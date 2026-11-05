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
  if (input.loading) return "keep";
  const sameCart = existing.cartId === input.cartId;
  const firstCart = existing.cartId == null && input.cartId != null;
  const claim = existing.accountId == null && input.accountId != null && (sameCart || firstCart);
  if (sameCart || firstCart || claim) return firstCart || claim ? "adopt" : "keep";
  return "reset";
}
