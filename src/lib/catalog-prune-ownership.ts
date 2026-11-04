import type { OwnershipBinding } from "./catalog-prune";

/**
 * Authoritative R2 account/bucket to database bindings.
 *
 * Empty on purpose. `african-markets-dev` is shared by production and preview,
 * and one process cannot see every database that might reference an object.
 * A bucket name in `SEED_PRUNE_R2` is not proof of ownership. Add a binding
 * only when a bucket has a single owning database and every catalog writer
 * joins the scan-to-delete gate. Until then, destructive prune stays refused.
 */
export const CATALOG_PRUNE_OWNERSHIP: OwnershipBinding[] = [];
