import { checkoutProfile, getFulfillmentOptions, prepareCheckout, setFulfillment, type PrepareResult } from "../checkout/prepare";
import { checkoutModelOutput } from "../checkout/safe-output";
import type { AssistantContext, ToolResult } from "./execute";
import { recordRead } from "./execute";

function asTool(result: PrepareResult): ToolResult {
  return result.ok
    ? { ...result, ok: true }
    : { ...result, ok: false, code: result.code ?? "checkout_unavailable", message: result.message ?? "Checkout is unavailable right now." };
}

export async function runGetFulfillmentOptions(ctx: AssistantContext): Promise<ToolResult> {
  const result = asTool(await getFulfillmentOptions(ctx));
  return recordRead(ctx, "get_fulfillment_options", {}, result);
}

export async function runSetFulfillment(ctx: AssistantContext, input: { slot_id: string }): Promise<ToolResult> {
  const result = asTool(await setFulfillment(ctx, input.slot_id));
  return recordRead(ctx, "set_fulfillment", input, result);
}

export async function runGetCheckoutProfile(ctx: AssistantContext): Promise<ToolResult> {
  const result = asTool(await checkoutProfile(ctx));
  return recordRead(ctx, "get_checkout_profile", {}, result);
}

export async function runPrepareCheckout(ctx: AssistantContext): Promise<ToolResult> {
  const result = asTool(await prepareCheckout(ctx));
  return recordRead(ctx, "prepare_checkout", {}, result);
}

export function checkoutToolModelOutput(output: unknown) {
  return { type: "text" as const, value: JSON.stringify(checkoutModelOutput(output)) };
}
