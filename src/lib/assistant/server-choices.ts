import { randomBytes } from "node:crypto";
import { scrubKnownStrings } from "./card-scrub";
import { offerChoices, type AssistantContext } from "./tools/execute";
import { offerChoicesInput } from "./tools/schemas";
import { textNamesProduct } from "./shown";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const CART_WRITE = new Set(["add_to_cart", "update_cart", "remove_from_cart", "set_swap_rule"]);

export type ServerChoiceChunk =
  | {
      type: "tool-input-available";
      toolCallId: string;
      toolName: "offer_choices";
      input: unknown;
    }
  | {
      type: "tool-output-available";
      toolCallId: string;
      output: unknown;
    };

/** `toolu_` plus 24 letters or digits. Never the reserved `srvtoolu_` prefix. */
export function serverToolCallId(): string {
  const bytes = randomBytes(24);
  let suffix = "";
  for (const byte of bytes) suffix += ALPHABET[byte % ALPHABET.length];
  return `toolu_${suffix}`;
}

/**
 * When one search named two or more products and the model did not offer them,
 * draw Choice chips with no extra model call. A failure writes nothing.
 */
export async function writeServerChoices(args: {
  steps: readonly unknown[];
  replyText: string;
  ctx: AssistantContext;
  write: (chunk: ServerChoiceChunk) => void;
}): Promise<void> {
  try {
    const choice = choiceInput(args.steps, args.replyText);
    if (!choice) return;
    const id = serverToolCallId();
    const result = await offerChoices({ ...args.ctx, toolCallId: id }, choice);
    if (!result.ok) return;
    args.write({
      type: "tool-input-available",
      toolCallId: id,
      toolName: "offer_choices",
      input: scrubKnownStrings(choice),
    });
    args.write({
      type: "tool-output-available",
      toolCallId: id,
      output: scrubKnownStrings(result),
    });
  } catch (error) {
    console.error("[assistant] server choices not drawn", args.ctx.conversationId, error);
  }
}

function choiceInput(steps: readonly unknown[], replyText: string): { options: Array<{ listing_id: string; variant_id?: string }> } | null {
  const searchIds = new Set<string>();
  const offerIds = new Set<string>();
  const outputs = new Map<string, unknown>();
  let cartOk = false;
  let anonymous = 0;
  const anonId = () => {
    anonymous += 1;
    return `anon-${anonymous}`;
  };
  for (const step of steps) {
    const record = asRecord(step);
    if (!record) continue;
    for (const call of asList(record.toolCalls)) {
      const name = typeof call.toolName === "string" ? call.toolName : "";
      const id = typeof call.toolCallId === "string" ? call.toolCallId : anonId();
      if (name === "search_catalog") searchIds.add(id);
      if (name === "offer_choices") offerIds.add(id);
    }
    for (const result of asList(record.toolResults)) {
      const name = typeof result.toolName === "string" ? result.toolName : "";
      const id = typeof result.toolCallId === "string" ? result.toolCallId : anonId();
      const output = unwrapOutput(result.output);
      if (name === "search_catalog") {
        searchIds.add(id);
        outputs.set(id, output);
      }
      if (name === "offer_choices") offerIds.add(id);
      if (CART_WRITE.has(name) && outputOk(output)) cartOk = true;
    }
  }
  if (searchIds.size !== 1 || offerIds.size > 0 || cartOk) return null;
  const items = searchItems(outputs.get([...searchIds][0] ?? ""));
  if (!items || items.length < 2) return null;
  const chosen: Array<{ listing_id: string; variant_id?: string }> = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.listingId)) continue;
    const names = [item.name, item.altName].filter((name): name is string => typeof name === "string" && name !== "");
    if (!textNamesProduct(replyText, names)) continue;
    seen.add(item.listingId);
    chosen.push({
      listing_id: item.listingId,
      ...(item.variantId ? { variant_id: item.variantId } : {}),
    });
    if (chosen.length === 6) break;
  }
  if (chosen.length < 2) return null;
  const parsed = offerChoicesInput.safeParse({ options: chosen });
  return parsed.success ? parsed.data : null;
}

function searchItems(output: unknown): Array<{ listingId: string; name: string; altName?: string; variantId?: string }> | null {
  const body = asRecord(output);
  if (!body || body.ok !== true || !Array.isArray(body.items)) return null;
  const items: Array<{ listingId: string; name: string; altName?: string; variantId?: string }> = [];
  for (const item of body.items) {
    const row = asRecord(item);
    if (!row || typeof row.listingId !== "string" || typeof row.name !== "string") continue;
    items.push({
      listingId: row.listingId,
      name: row.name,
      ...(typeof row.altName === "string" ? { altName: row.altName } : {}),
      ...(typeof row.variantId === "string" && row.variantId ? { variantId: row.variantId } : {}),
    });
  }
  return items;
}

function asList(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = asRecord(item);
    return record ? [record] : [];
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function unwrapOutput(output: unknown): unknown {
  const record = asRecord(output);
  if (record && record.type === "json" && "value" in record) return record.value;
  return output;
}

function outputOk(output: unknown): boolean {
  const record = asRecord(output);
  return !!record && record.ok === true;
}
