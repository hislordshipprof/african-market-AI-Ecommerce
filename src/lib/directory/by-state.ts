import { STATE_NAMES, isStateCode } from "./us-states";

type Linked = { slug: string; name: string; city: string | null; state: string | null; href: string };

/** Listed stores grouped under their state's full name, states A to Z (the directory's state list). */
export function groupByState(stores: Linked[]) {
  const groups = new Map<string, { code: string; name: string; stores: Omit<Linked, "state">[] }>();
  for (const { state, ...store } of stores) {
    if (!state || !isStateCode(state)) continue;
    const group = groups.get(state) ?? { code: state, name: STATE_NAMES[state], stores: [] };
    group.stores.push(store);
    groups.set(state, group);
  }
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
}
