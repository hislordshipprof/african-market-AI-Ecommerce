import { z } from "zod";
import { UNSET_MAX_PER_ORDER } from "../../cart/limits";
import { scrubKnownStrings } from "../card-scrub";
import { exactAssistantKeys } from "../contract";

const listingIds = (max: number) =>
  z.array(z.string().min(1)).min(1).max(max);

export const searchCatalogInput = z.object({
  query: z.string().min(1).max(100),
  limit: z.number().int().min(1).max(10).default(8),
});

export const showProductsInput = z.object({
  listing_ids: listingIds(10),
});

export const checkAvailabilityInput = z.object({
  listing_ids: listingIds(20),
});

export const suggestSubstitutesInput = z.object({
  listing_id: z.string().min(1),
});

export const addToCartInput = z.object({
  items: z.array(z.object({
    variant_id: z.string().min(1),
    qty: z.number().int().min(1).max(UNSET_MAX_PER_ORDER),
    backup_variant_id: z.string().min(1).optional(),
  })).min(1).max(20),
});

export const updateCartInput = z.object({
  line_id: z.string().min(1),
  qty: z.number().int().min(0).max(UNSET_MAX_PER_ORDER),
});

export const removeFromCartInput = z.object({
  line_id: z.string().min(1),
});

export const setSwapRuleInput = z.object({
  line_id: z.string().min(1),
  rule: z.enum(["exact_only", "store_suggests", "named_substitute"]),
  substitute_variant_id: z.string().min(1).optional(),
}).refine(
  (value) => value.rule !== "named_substitute" || !!value.substitute_variant_id,
  { message: "named_substitute requires substitute_variant_id" },
);

export const offerChoicesInput = z.object({
  options: z.array(z.object({
    listing_id: z.string().min(1),
    variant_id: z.string().min(1).optional(),
  })).min(2).max(6),
});

export const cartSummaryInput = z.object({});

const orderNumber = z.number().int().min(1).max(2_147_483_647).optional();

export const getOrderStatusInput = z.object({
  order_number: orderNumber,
});

export const checkDeliveryAreaInput = z.object({
  line1: z.string().trim().max(100).optional(),
  city: z.string().trim().max(60).optional(),
  state: z.string().trim().max(30).optional(),
  zip: z.string().trim().regex(/^\d{5}(-\d{4})?$/),
});

export const getStoreInfoInput = z.object({});

export const forwardToStoreInput = z.object({
  order_number: orderNumber,
  issue: z.string().trim().min(1).max(600),
});

export const toolInputSchemas = exactAssistantKeys({
  search_catalog: searchCatalogInput,
  show_products: showProductsInput,
  check_availability: checkAvailabilityInput,
  suggest_substitutes: suggestSubstitutesInput,
  add_to_cart: addToCartInput,
  update_cart: updateCartInput,
  remove_from_cart: removeFromCartInput,
  set_swap_rule: setSwapRuleInput,
  get_cart_summary: cartSummaryInput,
  offer_choices: offerChoicesInput,
  get_order_status: getOrderStatusInput,
  check_delivery_area: checkDeliveryAreaInput,
  get_store_info: getStoreInfoInput,
  forward_to_store: forwardToStoreInput,
});

function toolInput(input: unknown): unknown {
  if (typeof input !== "string") return scrubKnownStrings(input);
  try {
    return scrubKnownStrings(JSON.parse(input) as unknown);
  } catch {
    return scrubKnownStrings(input);
  }
}

export function parseToolInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(toolInput(input));
  if (!parsed.success) {
    const error = new Error("Invalid tool input");
    error.name = "InvalidToolInput";
    throw error;
  }
  return parsed.data;
}
