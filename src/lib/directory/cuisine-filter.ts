import { CUISINE_TAGS } from "./listing-fields";

type Tagged = { cuisineTags: readonly string[] };

export type CuisineChip = { value: string; label: string };

/** "Browse by where home is" (#690): only tags a listed store has, in the fixed list's order. */
export function cuisineChips(stores: readonly Tagged[]): CuisineChip[] {
  const used = new Set(stores.flatMap((store) => store.cuisineTags));
  return CUISINE_TAGS.filter((tag) => used.has(tag.value)).map(({ value, label }) => ({ value, label }));
}

/** No tag chosen keeps every store. */
export function withCuisine<T extends Tagged>(stores: readonly T[], tag: string | null): T[] {
  return tag ? stores.filter((store) => store.cuisineTags.includes(tag)) : [...stores];
}
