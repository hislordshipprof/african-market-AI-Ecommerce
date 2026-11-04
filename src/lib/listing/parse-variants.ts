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

/**
 * Reads the variants JSON the listing form posts.
 * Unknown fields are dropped. `id` is kept only when it is a non-empty string.
 */
export function parseVariantsJson(raw: string | null): ParsedVariant[] {
  if (!raw) return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("variants must be an array");
  return parsed.map((v: Record<string, unknown>, i: number) => {
    const n = i + 1;
    let id: string | undefined;
    if ("id" in v && v.id !== undefined) {
      if (typeof v.id !== "string" || v.id.length === 0) {
        throw new Error(`Variant ${n}: invalid id`);
      }
      id = v.id;
    }
    const price = Number(v.price);
    const weightG = Number(v.weightG);
    if (!isFinite(price) || price < 0) {
      throw new Error(`Variant ${n}: valid non-negative price is required`);
    }
    if (!Number.isInteger(price) || price > INT4_MAX) {
      throw new Error(`Variant ${n}: price must be a whole number of cents`);
    }
    if (!isFinite(weightG) || weightG <= 0) {
      throw new Error(`Variant ${n}: weight must be greater than 0`);
    }
    if (!Number.isInteger(weightG) || weightG > INT4_MAX) {
      throw new Error(`Variant ${n}: weight must be a whole number of grams`);
    }
    return {
      ...(id !== undefined ? { id } : {}),
      label: String(v.label ?? ""),
      price,
      weightG,
      sku: v.sku ? String(v.sku) : null,
      barcode: v.barcode ? String(v.barcode) : null,
    };
  });
}
