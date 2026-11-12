const NAME_MAX = 100;

/** One spelling per ingredient: trimmed, lower case, single spaces. */
export function normaliseIngredientName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ").slice(0, NAME_MAX);
}
