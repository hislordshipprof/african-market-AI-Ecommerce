export type PackIdentity = { id: string; price: number };

const utf8 = new TextEncoder();

/**
 * UTF-8 byte order. This is the same sequence as PostgreSQL `COLLATE "C"`,
 * including for ids outside the basic multilingual plane, where UTF-16 code
 * units and localeCompare disagree.
 */
export function comparePackIds(a: string, b: string): number {
  const left = utf8.encode(a);
  const right = utf8.encode(b);
  const length = Math.min(left.length, right.length);
  for (let i = 0; i < length; i++) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return left.length - right.length;
}

export function comparePacks(a: PackIdentity, b: PackIdentity): number {
  return a.price - b.price || comparePackIds(a.id, b.id);
}

/** Returns a new array. The input is left untouched. */
export function orderPacks<T extends PackIdentity>(packs: readonly T[]): T[] {
  return [...packs].sort(comparePacks);
}
