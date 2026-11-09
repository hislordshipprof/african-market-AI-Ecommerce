/**
 * Reply to a message from a verified store owner. This is the seam the Store
 * copilot ticket replaces; until then the owner gets a fixed acknowledgement
 * naming their own store.
 */
export function ownerMessageReply(input: { storeName: string }): string {
  return `This number is linked to ${input.storeName}. Store copilot replies are coming soon. For now, manage your store in store admin.`;
}
