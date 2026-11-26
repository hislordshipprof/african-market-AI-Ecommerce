import type { AisleChoice } from "@/lib/catalog/category-tree";

/** A select's options for the two-level tree (#861): each aisle's subcategories under it, or the aisle itself when it has none. */
export function CategoryOptions({ aisles }: { aisles: AisleChoice[] }) {
  return aisles.map((aisle) =>
    aisle.subcategories.length ? (
      <optgroup key={aisle.id} label={aisle.name}>
        {aisle.subcategories.map((sub) => (
          <option key={sub.id} value={sub.id}>{sub.name}</option>
        ))}
      </optgroup>
    ) : (
      <option key={aisle.id} value={aisle.id}>{aisle.name}</option>
    ));
}
