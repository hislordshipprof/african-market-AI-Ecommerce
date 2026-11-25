const HEALTH = /\b(cures?|heals?|healing|treats?|treatment|prevents?|boosts?|immun\w*|detox\w*|remed(y|ies)|medicin\w*|disease|diabetes|cancer|cholesterol|blood (pressure|sugar)|weight loss|lose weight|anti-?inflammatory|superfood|good for your)\b/i;
const PRICE = /[$€£₦]\s?\d|\b\d+(\.\d+)?\s?(dollars?|usd|cents?)\b|\bprices?d?\b|\bcheap(est)?\b|\bon sale\b|\bdiscount\w*|\d+\s?% off/i;

/** Places a grocery description might name as an origin. A name not in the product's own origin data is refused. */
const PLACES = [
  "Nigeria", "Ghana", "Cameroon", "Senegal", "Kenya", "Ethiopia", "Eritrea", "Somalia", "Sierra Leone", "Liberia", "Togo", "Benin",
  "Ivory Coast", "Côte d'Ivoire", "Gambia", "Guinea", "Mali", "Burkina Faso", "Niger", "Chad", "Sudan", "Egypt", "Morocco",
  "Tanzania", "Uganda", "Rwanda", "Congo", "Zimbabwe", "Zambia", "South Africa", "Angola", "Madagascar", "Jamaica", "Haiti",
  "Trinidad", "India", "Pakistan", "Thailand", "Vietnam", "China", "Brazil", "Mexico", "Italy", "France", "Netherlands",
  "Africa", "West Africa", "East Africa", "Caribbean",
];

/** What in a drafted description is more than the product data: a health claim, a price, or an origin it does not give. */
export function descriptionProblems(text: string, product: { originCountries: string | null }): string[] {
  const problems: string[] = [];
  if (HEALTH.test(text)) problems.push("a health claim");
  if (PRICE.test(text)) problems.push("a price");
  const known = (product.originCountries ?? "").toLowerCase();
  const named = PLACES.filter((place) => new RegExp(`\\b${place}\\b`, "i").test(text) && !known.includes(place.toLowerCase()));
  // "West Africa" also matches "Africa"; name the longest.
  const origins = named.filter((place) => !named.some((other) => other !== place && other.toLowerCase().includes(place.toLowerCase())));
  if (origins.length > 0) problems.push(`an origin the product data does not give (${origins.join(", ")})`);
  return problems;
}
