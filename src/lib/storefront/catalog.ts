import { AISLES } from "../catalog/category-tree";
import catalog from "./catalog-media.json";

type CatalogEntry = (typeof catalog)[keyof typeof catalog];
const entries: Record<string, CatalogEntry> = catalog;

export function catalogFor(...names: (string | null | undefined)[]) {
  let fallback: CatalogEntry | undefined;
  for (const name of names) {
    const entry = name ? entries[name.normalize("NFKC").trim().toLowerCase()] : undefined;
    if (entry?.imageUrl) return entry;
    if (entry) fallback ??= entry;
  }
  return fallback;
}

export function localNameFor(name: string) {
  const localNames: Record<string, string> = {
    Yam: "Isu · Puna yam",
    Plantain: "Dodo · Ripe plantain",
    Cassava: "Ege · Cassava root",
    Cocoyam: "Ede · Taro",
    "Sweet Potato": "Odunkun",
    "White Garri": "Gari · Cassava granules",
    Garri: "Gari · Cassava granules",
    "Yellow Garri (Ijebu)": "Gari · Cassava granules",
    "Egusi (Melon Seeds)": "Egusi · Melon seeds",
    "Ogbono (Wild Mango Seed)": "Ogbono · Wild mango seed",
    "Suya Spice": "Yaji · Ground spice blend",
    "Palm Oil": "Nkwu · Red palm oil",
    "Scotch Bonnet Pepper": "Ata rodo · Hot pepper",
    Okra: "Ila · Okro",
    "Garden Eggs": "African eggplant",
    "Bitter Leaf": "Onugbu · Ewuro",
    "Fluted Pumpkin Leaves (Ugu)": "Ugu · Fluted pumpkin leaves",
    "Ugu Leaves": "Ugu · Fluted pumpkin leaves",
    "Shea Butter": "Ori · Unrefined shea",
    Stockfish: "Okporoko · Dried cod",
    "Dried Hibiscus Flowers": "Zobo · Hibiscus flowers",
  };
  return localNames[name];
}

/** Each aisle's photo, by slug (#861). */
export const categoryPhotos: Record<string, string> = Object.fromEntries(
  AISLES.map((aisle) => [aisle.slug, entries[aisle.photo]?.imageUrl ?? ""]),
);

export function isServingSuggestion(url: string | undefined) {
  return !!url && /soup|Swallow|puff-puff|Suya_with/i.test(url);
}
