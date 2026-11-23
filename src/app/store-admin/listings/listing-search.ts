interface Named {
  customName: string | null;
  masterProductName: string | null;
  active: boolean;
}

export function displayNameOf(listing: Omit<Named, "active">): string {
  return listing.customName ?? listing.masterProductName ?? "Unnamed";
}

/** Filters the loaded listings by shown name and splits them into active and inactive. */
export function searchListings<T extends Named>(listings: T[], query: string): { active: T[]; inactive: T[] } {
  const needle = query.trim().toLowerCase();
  const matches = needle ? listings.filter((l) => displayNameOf(l).toLowerCase().includes(needle)) : listings;
  return { active: matches.filter((l) => l.active), inactive: matches.filter((l) => !l.active) };
}
