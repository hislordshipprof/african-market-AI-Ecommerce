import { z } from "zod";

/**
 * Master product statuses. Archived replaces delete: listings on it keep selling, nothing new matches it.
 * Merged is set only by a duplicate merge, which moves everything to the product it was merged into.
 */
export const MASTER_STATUSES = ["active", "needs_review", "rejected", "archived", "merged"] as const;
export type MasterStatus = (typeof MASTER_STATUSES)[number];

/** The statuses the editor may set. */
export const EDITABLE_STATUSES = ["active", "needs_review", "rejected", "archived"] as const satisfies readonly MasterStatus[];

export const MASTER_STATUS_LABELS: Record<MasterStatus, string> = {
  active: "Active",
  needs_review: "Needs review",
  rejected: "Rejected",
  archived: "Archived",
  merged: "Merged",
};

/** Every master product action refuses with this when the row moved on since the admin loaded it. */
export const STALE_PRODUCT_MESSAGE = "Someone else changed this product after you opened it. Reload the page to see their changes, then make yours again.";

/** A merged product is read-only: its listings and synonyms now live on the product it was merged into. */
export const MERGED_PRODUCT_MESSAGE = "This product was merged into another one and can no longer be edited.";

export const STORAGE_OPTIONS = ["ambient", "chilled", "frozen"] as const;

export const CATALOG_PAGE_SIZE = 25;

export const catalogFiltersSchema = z.strictObject({
  q: z.string().trim().max(200).optional(),
  category: z.string().max(200).optional(),
  status: z.enum(MASTER_STATUSES).optional(),
  photo: z.literal("missing").optional(),
  attributes: z.enum(["reviewed", "unreviewed"]).optional(),
  page: z.number().int().min(1).max(100_000).optional(),
  pageSize: z.number().int().min(1).max(100).optional(),
});
export type CatalogFilters = z.infer<typeof catalogFiltersSchema>;

/** The list page's query string as filters; an unknown value is dropped rather than failing the page. */
export function catalogFiltersFromSearchParams(params: Record<string, string | string[] | undefined>): CatalogFilters {
  const one = (key: string) => {
    const value = params[key];
    return typeof value === "string" && value !== "" ? value : undefined;
  };
  const filters: CatalogFilters = {};
  const q = one("q");
  if (q && q.trim().length <= 200) filters.q = q;
  const category = one("category");
  if (category && category.length <= 200) filters.category = category;
  const status = one("status");
  if (status && (MASTER_STATUSES as readonly string[]).includes(status)) filters.status = status as MasterStatus;
  if (one("photo") === "missing") filters.photo = "missing";
  const attributes = one("attributes");
  if (attributes === "reviewed" || attributes === "unreviewed") filters.attributes = attributes;
  const page = Number.parseInt(one("page") ?? "", 10);
  if (Number.isInteger(page) && page >= 1 && page <= 100_000) filters.page = page;
  return filters;
}

const optionalText = (max: number, message: string) =>
  z.string().trim().max(max, message).transform((value) => value || null);

export const masterProductFormSchema = z.strictObject({
  productId: z.string().min(1).max(200),
  version: z.string().min(1).max(200),
  name: z.string().trim().min(1, "Enter a name").max(200, "Keep the name under 200 characters"),
  categoryId: z.string().max(200).transform((value) => value || null),
  subcategory: optionalText(100, "Keep the subcategory under 100 characters"),
  description: optionalText(5000, "Keep the description under 5,000 characters"),
  unit: optionalText(40, "Keep the unit under 40 characters"),
  weightG: z
    .string()
    .trim()
    .refine((value) => value === "" || /^\d{1,6}$/.test(value), "Enter the weight in whole grams")
    .transform((value) => (value === "" ? null : Number(value)))
    .refine((value) => value === null || (value >= 1 && value <= 100_000), "Enter a weight between 1 and 100,000 grams"),
  frozen: z.boolean(),
  perishable: z.boolean(),
  storage: z.enum(["", ...STORAGE_OPTIONS], "Choose a storage option").transform((value) => value || null),
  status: z.enum(EDITABLE_STATUSES, "Choose a status"),
});
export type MasterProductForm = z.infer<typeof masterProductFormSchema>;
export type MasterProductField = Exclude<keyof MasterProductForm, "productId" | "version">;

/** The editor's form as the schema's input. A missing text field stays undefined so the schema refuses it. */
export function readMasterProductForm(form: FormData): Record<string, unknown> {
  const text = (key: string) => {
    const value = form.get(key);
    return typeof value === "string" ? value : undefined;
  };
  return {
    productId: text("productId"),
    version: text("version"),
    name: text("name"),
    categoryId: text("categoryId"),
    subcategory: text("subcategory"),
    description: text("description"),
    unit: text("unit"),
    weightG: text("weightG"),
    frozen: form.get("frozen") === "on",
    perishable: form.get("perishable") === "on",
    storage: text("storage"),
    status: text("status"),
  };
}
