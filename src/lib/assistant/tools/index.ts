import { tool, type Tool } from "ai";
import { exactAssistantKeys } from "../contract";
import { itemHandles, type ItemHandles } from "../handles";
import {
  addToCart,
  checkAvailability,
  getCartSummary,
  offerChoices,
  recordRead,
  removeFromCart,
  searchCatalog,
  setShopperNeeds,
  setSwapRule,
  showProducts,
  suggestSubstitutes,
  updateCart,
  type AssistantContext,
} from "./execute";
import { getFulfillmentOptions, prepareCheckout, setFulfillment } from "./checkout";
import { getRecipe, type RecipeDeps } from "./recipe";
import { checkDeliveryArea, forwardToStore, getOrderStatus, getStoreInfo } from "./store-questions";
import {
  addToCartInput,
  cartSummaryInput,
  checkAvailabilityInput,
  checkDeliveryAreaInput,
  forwardToStoreInput,
  getFulfillmentOptionsInput,
  prepareCheckoutInput,
  setFulfillmentInput,
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

export function assistantTools(
  ctx: AssistantContext,
  recipeDeps: RecipeDeps = {},
  handles: ItemHandles = itemHandles(ctx.storeId, ctx.conversationId),
) {
  return withItemHandles(ctx, handles, exactAssistantKeys({
    search_catalog: tool({
      description: "Search this store's catalog. query is the product words only, including a brand the customer named. pack is a size or pack the customer named, such as \"400 g tin\" or \"bag\". Match name or match synonym is a fit. Match near is not a fit on an explicit add. Search returns the cheapest variant. When pack does not appear on that variant's label, call show_products and add the variant whose label shows it.",
      inputSchema: searchCatalogInput,
      execute: (input, options) => searchCatalog({ ...ctx, toolCallId: options.toolCallId }, input),
    }),
    set_shopper_needs: tool({
      description: "Save what the customer must avoid or needs, from their own words: allergens, dietary claims, and ingredients; also a budget and items already at home. Kept for this conversation. Searches, recipes and adds check it. A term that only names a form of a known ingredient returns ask.",
      inputSchema: setShopperNeedsInput,
      execute: (input, options) => setShopperNeeds({ ...ctx, toolCallId: options.toolCallId }, input),
    }),
    show_products: tool({
      description: "Show product cards for listing handles from this chat. A card's about and alsoCalled explain what the item is.",
      inputSchema: showProductsInput,
      execute: (input, options) => showProducts({ ...ctx, toolCallId: options.toolCallId }, input),
    }),
    check_availability: tool({
      description: "Check live stock and price for listing handles from this chat.",
      inputSchema: checkAvailabilityInput,
      execute: (input, options) => checkAvailability({ ...ctx, toolCallId: options.toolCallId }, input),
    }),
    suggest_substitutes: tool({
      description: "Suggest in-stock products in the same category as a swap, each with a variantId to keep as the named substitute.",
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
      description: "Status and lines of the signed-in customer's own orders at this store. Each line's variantId reorders it. Omit order_number for the newest.",
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
    get_fulfillment_options: tool({
      description: "Today's pickup times at this store, in store time. Delivery is chosen on the checkout page.",
      inputSchema: getFulfillmentOptionsInput,
      execute: (input, options) => getFulfillmentOptions({ ...ctx, toolCallId: options.toolCallId }, input),
    }),
    set_fulfillment: tool({
      description: "Save the pickup time the customer chose, by a slotId from get_fulfillment_options. Checkout pre-selects it.",
      inputSchema: setFulfillmentInput,
      execute: (input, options) => setFulfillment({ ...ctx, toolCallId: options.toolCallId }, input),
    }),
    prepare_checkout: tool({
      description: "Show the customer a Review card for the current cart: lines, pickup time, fees, total and card hold, with a Review and pay button to the checkout page. It places no order and takes no payment; only the customer can pay, on the checkout page.",
      inputSchema: prepareCheckoutInput,
      execute: (input, options) => prepareCheckout({ ...ctx, toolCallId: options.toolCallId }, input),
    }),
  }));
}

/** The model passes and sees short item handles; the tools themselves keep working on ids. */
function withItemHandles<T extends Record<string, Tool>>(ctx: AssistantContext, handles: ItemHandles, tools: T): T {
  const wrapped = Object.entries(tools).map(([name, item]) => {
    const execute = item.execute!;
    return [name, {
      ...item,
      execute: async (input: unknown, options: Parameters<typeof execute>[1]) => {
        const resolved = await handles.resolve(input);
        if (!resolved.ok) {
          const list = resolved.handles.join(", ");
          return recordRead({ ...ctx, toolCallId: options.toolCallId }, name, input, {
            ok: false,
            code: "unknown_handle",
            message: `Not an item handle from this chat: ${list}. Use a handle a tool returned here, such as i3 or v12, or search again.`,
            handles: resolved.handles,
          });
        }
        return execute(resolved.input, options);
      },
      toModelOutput: async ({ output }: { output: unknown }) => ({ type: "json" as const, value: await handles.toModel(output) as never }),
    }];
  });
  return Object.fromEntries(wrapped) as T;
}
