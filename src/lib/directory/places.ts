import { STATE_NAMES, isStateCode, type StateCode } from "./us-states";

type Placed = { slug: string; city: string | null; state: string | null };

export type CityGroup<T> = { name: string; slug: string; stores: T[] };
export type StateGroupPage<T> = { code: StateCode; name: string; slug: string; stores: T[]; cities: CityGroup<T>[] };

/** URL segment for a state or city name: "Silver Spring" → "silver-spring". */
export function placeSlug(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function stateSlug(code: StateCode): string {
  return placeSlug(STATE_NAMES[code]);
}

/** Every state with a listed store, A to Z, each with its cities A to Z (the state and city pages, #451). */
export function statePages<T extends Placed>(stores: T[]): StateGroupPage<T>[] {
  const states = new Map<StateCode, StateGroupPage<T>>();
  for (const store of stores) {
    if (!store.state || !isStateCode(store.state)) continue;
    const code = store.state;
    const state = states.get(code) ?? { code, name: STATE_NAMES[code], slug: stateSlug(code), stores: [], cities: [] };
    state.stores.push(store);
    states.set(code, state);
    const name = store.city?.trim();
    const slug = name ? placeSlug(name) : "";
    if (!name || !slug) continue;
    const city = state.cities.find((c) => c.slug === slug);
    if (city) city.stores.push(store);
    else state.cities.push({ name, slug, stores: [store] });
  }
  const sorted = [...states.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const state of sorted) state.cities.sort((a, b) => a.name.localeCompare(b.name));
  return sorted;
}

/** Null when no listed store is in the state, so the page 404s. */
export function statePage<T extends Placed>(stores: T[], slug: string): StateGroupPage<T> | null {
  return statePages(stores).find((state) => state.slug === slug) ?? null;
}

/** Null when no listed store is in the city: no thin pages. */
export function cityPage<T extends Placed>(stores: T[], state: string, city: string) {
  const page = statePage(stores, state);
  const match = page?.cities.find((c) => c.slug === city);
  return page && match ? { state: page, city: match.name, slug: match.slug, stores: match.stores } : null;
}
