import { tool } from "ai";
import { exactAssistantKeys } from "../contract";
import {
  addToCart,
  checkAvailability,
  getCartSummary,
  offerChoices,
  removeFromCart,
  searchCatalog,
  setShopperNeeds,
  setSwapRule,
  showProducts,
  suggestSubstitutes,
  updateCart,
  type AssistantContext,
} from "./execute";
import { getRecipe, type RecipeDeps } from "./recipe";
import { checkDeliveryArea, forwardToStore, getOrderStatus, getStoreInfo } from "./store-questions";
import {
  addToCartInput,
  cartSummaryInput,
  checkAvailabilityInput,
  checkDeliveryAreaInput,
  forwardToStoreInput,
  getRecipeInput,
  getOrderStatusInput,
  getStoreInfoInput,
  removeFromCartInput,
  searchCatalogInput,
  offerChoicesInput,
  setShopperNeedsInput,
  setSwapRuleInput,
  showProductsInput,
  suggestSubstitutesInput,
  updateCartInput,
} from "./schemas";

export type { AssistantContext, ToolResult } from "./execute";
export { toolInputSchemas } from "./schemas";

export function assistantTools(ctx: AssistantContext, recipeDeps: RecipeDeps = {}) {
  return exactAssistantKeys({
    search_catalog: tool({
      description: "Search this store's catalog. query is the product words only, including a brand the customer named. pack is a size or pack the customer named, such as \"400 g tin\" or \"bag\". Match name or match synonym is a fit. Match near is not a fit on an explicit add. Search returns the cheapest variant. When pack does not appear on that variant's label, call show_products and add the variant whose label shows it.",
      inputSchema: searchCatalogInput,
      execute: (input, options) => searchCatalog({ ...ctx, toolCallId: options.toolCallId }, input),
    }),
    set_shopper_needs: tool({
      description: "Save what the customer must avoid or needs, from their own words: allergens, dietary claims, and ingredients. Kept for this conversation. Searches, recipes and adds check it. A term that only names a form of a known ingredient returns ask.",
      inputSchema: setShopperNeedsInput,
      execute: (input, options) => setShopperNeeds({ ...ctx, toolCallId: options.toolCallId }, input),
    }),
    show_products: tool({
      description: "Show product cards for listing ids in this store.",
      inputSchema: showProductsInput,
      execute: (input, options) => showProducts({ ...ctx, toolCallId: options.toolCallId }, input),
    }),
    check_availability: tool({
      description: "Check live stock and price for listing ids in this store.",
      inputSchema: checkAvailabilityInput,
      execute: (input, options) => checkAvailability({ ...ctx, toolCallId: options.toolCallId }, input),
    }),
    suggest_substitutes: tool({
      description: "Suggest other active products in the same category.",
      inputSchema: suggestSubstitutesInput,
      execute: (input, options) => suggestSubstitutes({ ...ctx, toolCallId: options.toolCallId }, input),
    }),
    add_to_cart: tool({
      description: "Add items to this customer's cart.",
      inputSchema: addToCartInput,
      execute: (input, options) => addToCart({ ...ctx, toolCallId: options.toolCallId }, input),
    }),
    update_cart: tool({
      description: "Change a cart line quantity. Zero removes the line.",
      inputSchema: updateCartInput,
      execute: (input, options) => updateCart({ ...ctx, toolCallId: options.toolCallId }, input),
    }),
    remove_from_cart: tool({
      description: "Remove a cart line.",
      inputSchema: removeFromCartInput,
      execute: (input, options) => removeFromCart({ ...ctx, toolCallId: options.toolCallId }, input),
    }),
    set_swap_rule: tool({
      description: "Set how the store should handle a line that is short. A may-be-unavailable line keeps a backup: store_suggests or named_substitute, never exact_only.",
      inputSchema: setSwapRuleInput,
      execute: (input, options) => setSwapRule({ ...ctx, toolCallId: options.toolCallId }, input),
    }),
    get_cart_summary: tool({
      description: "Read the current cart, prices, service fee, total, and minimum order.",
      inputSchema: cartSummaryInput,
      execute: (input, options) => getCartSummary({ ...ctx, toolCallId: options.toolCallId }, input),
    }),
    offer_choices: tool({
      description: "Offer 2 to 6 products from this store and wait for the customer to pick one.",
      inputSchema: offerChoicesInput,
      execute: (input, options) => offerChoices({ ...ctx, toolCallId: options.toolCallId }, input),
    }),
    get_order_status: tool({
      description: "Status of the signed-in customer's own orders at this store. Omit order_number for the newest.",
      inputSchema: getOrderStatusInput,
      execute: (input, options) => getOrderStatus({ ...ctx, toolCallId: options.toolCallId }, input),
    }),
    check_delivery_area: tool({
      description: "Check whether a street address is inside this store's delivery area.",
      inputSchema: checkDeliveryAreaInput,
      execute: (input, options) => checkDeliveryArea({ ...ctx, toolCallId: options.toolCallId }, input),
    }),
    get_store_info: tool({
      description: "This store's hours, minimum order, pickup, delivery, refund policy and story.",
      inputSchema: getStoreInfoInput,
      execute: (input, options) => getStoreInfo({ ...ctx, toolCallId: options.toolCallId }, input),
    }),
    forward_to_store: tool({
      description: "Send a complaint or refund request about the customer's own order to the store's order messages.",
      inputSchema: forwardToStoreInput,
      execute: (input, options) => forwardToStore({ ...ctx, toolCallId: options.toolCallId }, input),
    }),
    get_recipe: tool({
      description: "Ingredients for a dish the customer named, matched to this store: inStock, lowOrOut with a backup, notCarried, and excluded for ingredients whose every item fails the customer's saved needs. Omit servings when the customer did not say how many people; it then returns askServings.",
      inputSchema: getRecipeInput,
      execute: (input, options) => getRecipe({ ...ctx, toolCallId: options.toolCallId }, input, recipeDeps),
    }),
  });
}
