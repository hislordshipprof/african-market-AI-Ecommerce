import { tool, type ToolSet } from "ai";
import {
  addToCart,
  checkAvailability,
  getCartSummary,
  offerChoices,
  removeFromCart,
  searchCatalog,
  setSwapRule,
  showProducts,
  suggestSubstitutes,
  updateCart,
  type AssistantContext,
} from "./execute";
import {
  addToCartInput,
  cartSummaryInput,
  checkAvailabilityInput,
  removeFromCartInput,
  searchCatalogInput,
  offerChoicesInput,
  setSwapRuleInput,
  showProductsInput,
  suggestSubstitutesInput,
  updateCartInput,
} from "./schemas";

export type { AssistantContext, ToolResult } from "./execute";
export { toolInputSchemas } from "./schemas";

export function assistantTools(ctx: AssistantContext): ToolSet {
  return {
    search_catalog: tool({
      description: "Search this store's catalog.",
      inputSchema: searchCatalogInput,
      execute: (input) => searchCatalog(ctx, input),
    }),
    show_products: tool({
      description: "Show product cards for listing ids in this store.",
      inputSchema: showProductsInput,
      execute: (input) => showProducts(ctx, input),
    }),
    check_availability: tool({
      description: "Check live stock and price for listing ids in this store.",
      inputSchema: checkAvailabilityInput,
      execute: (input) => checkAvailability(ctx, input),
    }),
    suggest_substitutes: tool({
      description: "Suggest other active products in the same category.",
      inputSchema: suggestSubstitutesInput,
      execute: (input) => suggestSubstitutes(ctx, input),
    }),
    add_to_cart: tool({
      description: "Add items to this customer's cart.",
      inputSchema: addToCartInput,
      execute: (input) => addToCart(ctx, input),
    }),
    update_cart: tool({
      description: "Change a cart line quantity. Zero removes the line.",
      inputSchema: updateCartInput,
      execute: (input) => updateCart(ctx, input),
    }),
    remove_from_cart: tool({
      description: "Remove a cart line.",
      inputSchema: removeFromCartInput,
      execute: (input) => removeFromCart(ctx, input),
    }),
    set_swap_rule: tool({
      description: "Set how the store should handle a line that is short.",
      inputSchema: setSwapRuleInput,
      execute: (input) => setSwapRule(ctx, input),
    }),
    get_cart_summary: tool({
      description: "Read the current cart, prices, and minimum order.",
      inputSchema: cartSummaryInput,
      execute: (input) => getCartSummary(ctx, input),
    }),
    offer_choices: tool({
      description: "Offer 2 to 6 products from this store and wait for the customer to pick one.",
      inputSchema: offerChoicesInput,
      execute: (input) => offerChoices(ctx, input),
    }),
  };
}
