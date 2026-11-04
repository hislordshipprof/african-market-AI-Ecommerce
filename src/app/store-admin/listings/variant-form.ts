/** One variant row from the listing form. `key` is a React key and is never sent. */
export interface VariantFormSnapshot {
  key?: string;
  /** Set only for a row loaded from the listing. A new row leaves this unset. */
  id?: string;
  label: string;
  /** Dollars, as typed. */
  price: string;
  weightG: string;
  sku?: string | null;
  barcode?: string | null;
}

/** A variant loaded from the listing. The React key is the id, and the id is sent back on save. */
export function loadedVariantRow(variant: {
  id: string;
  label: string;
  price: number;
  weightG: number;
  sku: string | null;
  barcode: string | null;
}): VariantFormSnapshot & { key: string } {
  return {
    key: variant.id,
    id: variant.id,
    label: variant.label,
    price: (variant.price / 100).toFixed(2),
    weightG: String(variant.weightG),
    sku: variant.sku,
    barcode: variant.barcode,
  };
}

/** Serialises variant rows for the listing form. Blank labels are omitted. */
export function serializeVariants(variants: VariantFormSnapshot[]): string {
  return JSON.stringify(
    variants
      .filter((variant) => variant.label.trim())
      .map((variant) => {
        const row: {
          id?: string;
          label: string;
          price: number;
          weightG: number;
          sku: string | null;
          barcode: string | null;
        } = {
          label: variant.label.trim(),
          price: Math.round(parseFloat(variant.price || "0") * 100),
          weightG: parseInt(variant.weightG || "0", 10),
          sku: variant.sku ?? null,
          barcode: variant.barcode ?? null,
        };
        if (typeof variant.id === "string" && variant.id.length > 0) row.id = variant.id;
        return row;
      }),
  );
}
