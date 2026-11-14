/** Parsed variant row. `id` is set only when the client sent a non-empty string. */
export interface ParsedVariant {
  id?: string;
  label: string;
  price: number;
  weightG: number;
  sku: string | null;
  barcode: string | null;
}

const INT4_MAX = 2147483647;

const VARIANT_KEYS = new Set(["id", "label", "price", "weightG", "sku", "barcode"]);

/**
 * Reads the variants JSON the listing form posts.
 * Unknown keys are rejected. Money is an integer number of cents, never coerced.
 * `id` is kept only when it is a non-empty string.
 */
export function parseVariantsJson(raw: string | null): ParsedVariant[] {
  if (!raw) return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("variants must be an array");
  return parsed.map((item: unknown, i: number) => {
    const n = i + 1;
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`Variant ${n}: invalid variant`);
    }
    const v = item as Record<string, unknown>;
    for (const key of Object.keys(v)) {
      if (!VARIANT_KEYS.has(key)) throw new Error(`Variant ${n}: unknown field`);
    }
    let id: string | undefined;
    if ("id" in v && v.id !== undefined) {
      if (typeof v.id !== "string" || v.id.length === 0) {
        throw new Error(`Variant ${n}: invalid id`);
      }
      id = v.id;
    }
    if (typeof v.label !== "string" || !v.label.trim()) {
      throw new Error(`Variant ${n}: label is required`);
    }
    const price = v.price;
    const weightG = v.weightG;
    if (typeof price !== "number" || !isFinite(price) || price < 0) {
      throw new Error(`Variant ${n}: valid non-negative price is required`);
    }
    if (!Number.isInteger(price) || price > INT4_MAX) {
      throw new Error(`Variant ${n}: price must be a whole number of cents`);
    }
    if (typeof weightG !== "number" || !isFinite(weightG) || weightG <= 0) {
      throw new Error(`Variant ${n}: weight must be greater than 0`);
    }
    if (!Number.isInteger(weightG) || weightG > INT4_MAX) {
      throw new Error(`Variant ${n}: weight must be a whole number of grams`);
    }
    if (v.sku != null && typeof v.sku !== "string") {
      throw new Error(`Variant ${n}: sku must be text`);
    }
    if (v.barcode != null && typeof v.barcode !== "string") {
      throw new Error(`Variant ${n}: barcode must be text`);
    }
    return {
      ...(id !== undefined ? { id } : {}),
      label: v.label,
      price,
      weightG,
      sku: typeof v.sku === "string" && v.sku ? v.sku : null,
      barcode: typeof v.barcode === "string" && v.barcode ? v.barcode : null,
    };
  });
}
