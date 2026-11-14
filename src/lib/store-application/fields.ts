/** Store types an applicant picks on /sell (#554). Any independent grocery or food store may apply (ADR-0004). */
export const STORE_TYPES = [
  { value: "african", label: "African grocery" },
  { value: "caribbean", label: "Caribbean grocery" },
  { value: "other_grocery", label: "Other grocery" },
  { value: "specialty_food", label: "Specialty food store" },
] as const;

export type StoreType = (typeof STORE_TYPES)[number]["value"];

export function storeTypeLabel(value: string): string {
  return STORE_TYPES.find((type) => type.value === value)?.label ?? value;
}

export const APPLICATION_FIELDS = [
  "businessName", "storeType", "addressLine1", "city", "state", "zip",
  "ownerName", "email", "phone", "website", "offersPickup", "offersDelivery",
  // Honeypot: hidden from people, so only a bot fills it.
  "fax",
] as const;

export type ApplicationField = (typeof APPLICATION_FIELDS)[number];

export const REJECT_REASON_MAX = 500;

/** A first guess at the store's slug from its name; the admin can change it before approving. */
export function suggestSlug(businessName: string): string {
  return businessName
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 63)
    .replace(/^-+|-+$/g, "");
}
