import { tool } from "ai";
import { exactAssistantKeys } from "../contract";
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
import { checkoutToolModelOutput, runGetCheckoutProfile, runGetFulfillmentOptions, runPrepareCheckout, runSetFulfillment } from "./checkout";
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
  checkoutProfileInput,
  fulfillmentOptionsInput,
  prepareCheckoutInput,
  setFulfillmentInput,
} from "./schemas";

export type { AssistantContext, ToolResult } from "./execute";
export { toolInputSchemas } from "./schemas";

export function assistantTools(ctx: AssistantContext) {
  return exactAssistantKeys({
    search_catalog: tool({
      description: "Search this store's catalog.",
      inputSchema: searchCatalogInput,
      execute: (input, options) => searchCatalog({ ...ctx, toolCallId: options.toolCallId }, input),
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
      description: "Set how the store should handle a line that is short.",
      inputSchema: setSwapRuleInput,
      execute: (input, options) => setSwapRule({ ...ctx, toolCallId: options.toolCallId }, input),
    }),
    get_cart_summary: tool({
      description: "Read the current cart, prices, and minimum order.",
      inputSchema: cartSummaryInput,
      execute: (input, options) => getCartSummary({ ...ctx, toolCallId: options.toolCallId }, input),
    }),
    offer_choices: tool({
      description: "Offer 2 to 6 products from this store and wait for the customer to pick one.",
      inputSchema: offerChoicesInput,
      execute: (input, options) => offerChoices({ ...ctx, toolCallId: options.toolCallId }, input),
    }),
    get_fulfillment_options: tool({
      description: "List today's pickup times. Pickup only. Does not place an order.",
      inputSchema: fulfillmentOptionsInput,
      execute: (_input, options) => runGetFulfillmentOptions({ ...ctx, toolCallId: options.toolCallId }),
      toModelOutput: ({ output }) => checkoutToolModelOutput(output),
    }),
    set_fulfillment: tool({
      description: "Save a pickup time from get_fulfillment_options. Does not place an order.",
      inputSchema: setFulfillmentInput,
      execute: (input, options) => runSetFulfillment({ ...ctx, toolCallId: options.toolCallId }, input),
      toModelOutput: ({ output }) => checkoutToolModelOutput(output),
    }),
    get_checkout_profile: tool({
      description: "Say whether contact and a saved card are on file. Never returns the card number, email, phone, or a payment id.",
      inputSchema: checkoutProfileInput,
      execute: (_input, options) => runGetCheckoutProfile({ ...ctx, toolCallId: options.toolCallId }),
      toModelOutput: ({ output }) => checkoutToolModelOutput(output),
    }),
    prepare_checkout: tool({
      description: "Draw a confirm card for the customer to tap. This does not place the order or charge a card.",
      inputSchema: prepareCheckoutInput,
      execute: (_input, options) => runPrepareCheckout({ ...ctx, toolCallId: options.toolCallId }),
      toModelOutput: ({ output }) => checkoutToolModelOutput(output),
    }),
  });
}
