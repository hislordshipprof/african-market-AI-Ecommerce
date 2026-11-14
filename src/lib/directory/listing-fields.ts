// The owner's directory fields, safe for the client. The directory's fixed cuisine tags. Any grocery or food store can join (ADR-0004), so the
// list runs past African food; stored as the value, shown as the label.
export const CUISINE_TAGS = [
  { value: "west-african", label: "West African" },
  { value: "east-african", label: "East African" },
  { value: "ethiopian-eritrean", label: "Ethiopian and Eritrean" },
  { value: "central-african", label: "Central African" },
  { value: "southern-african", label: "Southern African" },
  { value: "north-african", label: "North African" },
  { value: "caribbean", label: "Caribbean" },
  { value: "latin-american", label: "Latin American" },
  { value: "middle-eastern", label: "Middle Eastern" },
  { value: "south-asian", label: "South Asian" },
  { value: "east-asian", label: "East Asian" },
  { value: "halal-butcher", label: "Halal butcher" },
] as const;

export type CuisineTag = (typeof CUISINE_TAGS)[number]["value"];

export const CUISINE_TAG_VALUES = CUISINE_TAGS.map((tag) => tag.value) as [CuisineTag, ...CuisineTag[]];

/** Also a database check (stores_cuisine_tags_max). */
export const CUISINE_TAGS_MAX = 3;

export const LISTING_BLURB_MAX = 160;

const LABELS = new Map<string, string>(CUISINE_TAGS.map((tag) => [tag.value, tag.label]));

/** Labels in list order; a value no longer on the list is dropped. */
export function cuisineLabels(values: readonly string[]): string[] {
  return CUISINE_TAGS.filter((tag) => values.includes(tag.value)).map((tag) => tag.label);
}

export function isCuisineTag(value: string): value is CuisineTag {
  return LABELS.has(value);
}

/** One line, trimmed; empty is no blurb. */
export function normalizeBlurb(raw: string): string | null {
  const blurb = raw.replace(/\s+/g, " ").trim();
  return blurb === "" ? null : blurb;
}

/** Postgres VARCHAR counts characters, not UTF-16 units. */
export function blurbLength(blurb: string): number {
  return [...blurb].length;
}
