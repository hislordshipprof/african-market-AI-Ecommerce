import { money } from "@/lib/format";
import { ASSISTANT_FIXED_ERROR } from "../contract";

export const CARD_TOOL_ERROR = ASSISTANT_FIXED_ERROR;

export type ProductCard = {
  kind: "product";
  key: string;
  name: string;
  packLabel: string;
  priceCents: number;
  priceLabel: string;
  imageUrl: string | null;
  mayBeUnavailable: boolean;
};

export type AddedCard = {
  kind: "added";
  key: string;
  additionId: string;
  lineId: string;
  name: string;
  packLabel: string | null;
  qtyAdded: number;
  limitedTo: number | null;
  legacy: boolean;
};

export type MissingCard = {
  kind: "missing";
  key: string;
  message: string;
};

export type SummaryLine = {
  lineId: string;
  name: string;
  packLabel: string;
  qty: number;
  lineTotalCents: number;
  lineTotalLabel: string;
};

export type SummaryCard = {
  kind: "summary";
  key: string;
  lines: SummaryLine[];
  subtotalCents: number;
  subtotalLabel: string;
  minimumOrderCents: number;
  minimumMet: boolean;
  missingCents: number;
  missingLabel: string;
  gapLabel: string | null;
};

export type ChoiceOption = {
  choiceId: string;
  label: string;
  sendText: string;
};

export type ChoiceCard = {
  kind: "choices";
  key: string;
  options: ChoiceOption[];
};

export type SkeletonCard = { kind: "skeleton"; key: string };
export type ToolErrorCard = { kind: "tool-error"; key: string; message: string };

export type AssistantCard =
  | ProductCard
  | AddedCard
  | MissingCard
  | SummaryCard
  | ChoiceCard
  | SkeletonCard
  | ToolErrorCard;

type Part = {
  type?: unknown;
  state?: unknown;
  toolCallId?: unknown;
  toolName?: unknown;
  input?: unknown;
  output?: unknown;
  errorText?: unknown;
  text?: unknown;
  data?: unknown;
};

const CART_TOOLS = new Set(["add_to_cart", "update_cart", "remove_from_cart", "set_swap_rule"]);

export function cardsFromParts(parts: readonly Part[], options?: { turnFailed?: boolean }): AssistantCard[] {
  const cards: AssistantCard[] = [];
  parts.forEach((part, index) => {
    const type = typeof part.type === "string" ? part.type : "";
    if (type === "data-step-limit" || type === "text" || type === "step-start") return;
    const tool = toolNameOf(part, type);
    if (!tool) return;
    const callId = typeof part.toolCallId === "string" ? part.toolCallId : `part-${index}`;
    const state = typeof part.state === "string" ? part.state : "";
    if (state === "input-streaming" || state === "input-available") {
      cards.push(options?.turnFailed
        ? { kind: "tool-error", key: `${callId}:error`, message: CARD_TOOL_ERROR }
        : { kind: "skeleton", key: `${callId}:skeleton` });
      return;
    }
    if (state === "output-error") {
      cards.push({ kind: "tool-error", key: `${callId}:error`, message: CARD_TOOL_ERROR });
      return;
    }
    if (state !== "output-available") return;
    cards.push(...cardsForOutput(tool, callId, part.input, part.output));
  });
  return cards;
}

export function cartToolCallIds(parts: readonly Part[]): string[] {
  const ids: string[] = [];
  for (const part of parts) {
    const type = typeof part.type === "string" ? part.type : "";
    const tool = toolNameOf(part, type);
    if (!tool || !CART_TOOLS.has(tool)) continue;
    if (part.state !== "output-available") continue;
    const output = isRecord(part.output) ? part.output : null;
    if (!output || output.ok !== true) continue;
    if (typeof part.toolCallId === "string") ids.push(part.toolCallId);
  }
  return ids;
}

function toolNameOf(part: Part, type: string): string | null {
  if (type === "dynamic-tool") {
    return typeof part.toolName === "string" ? part.toolName : null;
  }
  if (type.startsWith("tool-")) return type.slice("tool-".length);
  return null;
}

function cardsForOutput(tool: string, callId: string, input: unknown, output: unknown): AssistantCard[] {
  if (tool === "search_catalog") return searchCards(callId, input, output);
  if (tool === "show_products") return showCards(callId, output);
  if (tool === "add_to_cart") return addedCards(callId, output);
  if (tool === "offer_choices") return choiceCards(callId, output);
  if (tool === "get_cart_summary") return summaryCards(callId, output);
  return [];
}

function searchCards(callId: string, input: unknown, output: unknown): AssistantCard[] {
  const body = isRecord(output) ? output : {};
  const items = Array.isArray(body.items) ? body.items : [];
  if (items.length === 0) {
    const query = isRecord(input) && typeof input.query === "string" ? input.query : "";
    const message = query ? `Couldn't find “${query}”.` : "Couldn't find that.";
    return [{ kind: "missing", key: `${callId}:missing`, message }];
  }
  return items.flatMap((item, index) => {
    const card = productFromSearch(item, `${callId}:product:${index}`);
    return card ? [card] : [];
  });
}

function productFromSearch(item: unknown, key: string): ProductCard | null {
  if (!isRecord(item)) return null;
  if (typeof item.name !== "string" || typeof item.priceCents !== "number") return null;
  const packLabel = typeof item.packLabel === "string" ? item.packLabel : "Each";
  const imageUrl = typeof item.imageUrl === "string" ? item.imageUrl : null;
  return {
    kind: "product",
    key,
    name: item.name,
    packLabel,
    priceCents: item.priceCents,
    priceLabel: money(item.priceCents),
    imageUrl,
    mayBeUnavailable: item.mayBeUnavailable === true,
  };
}

function showCards(callId: string, output: unknown): AssistantCard[] {
  const body = isRecord(output) ? output : {};
  const cards: AssistantCard[] = [];
  const raw = Array.isArray(body.cards) ? body.cards : [];
  raw.forEach((card, index) => {
    const product = productFromShow(card, `${callId}:product:${index}`);
    if (product) cards.push(product);
  });
  const notFound = Array.isArray(body.notFound) ? body.notFound : [];
  if (notFound.length > 0) {
    cards.push({
      kind: "missing",
      key: `${callId}:missing`,
      message: "Some products are not in this store.",
    });
  }
  return cards;
}

function productFromShow(card: unknown, key: string): ProductCard | null {
  if (!isRecord(card) || typeof card.name !== "string") return null;
  const variants = Array.isArray(card.variants) ? card.variants.filter(isRecord) : [];
  if (variants.length === 0) return null;
  const cheapest = [...variants].sort((a, b) => {
    const priceA = typeof a.priceCents === "number" ? a.priceCents : Number.MAX_SAFE_INTEGER;
    const priceB = typeof b.priceCents === "number" ? b.priceCents : Number.MAX_SAFE_INTEGER;
    if (priceA !== priceB) return priceA - priceB;
    const idA = typeof a.variantId === "string" ? a.variantId : "";
    const idB = typeof b.variantId === "string" ? b.variantId : "";
    return idA < idB ? -1 : idA > idB ? 1 : 0;
  })[0];
  if (!cheapest || typeof cheapest.priceCents !== "number") return null;
  const packLabel = typeof cheapest.label === "string" ? cheapest.label : "Each";
  const imageUrl = typeof card.imageUrl === "string" ? card.imageUrl : null;
  return {
    kind: "product",
    key,
    name: card.name,
    packLabel,
    priceCents: cheapest.priceCents,
    priceLabel: money(cheapest.priceCents),
    imageUrl,
    mayBeUnavailable: card.mayBeUnavailable === true,
  };
}

function addedCards(callId: string, output: unknown): AssistantCard[] {
  const body = isRecord(output) ? output : null;
  if (!body) return [];
  const items = Array.isArray(body.items) ? body.items : null;
  if (items) {
    return items.flatMap((item, index) => addedItem(item, callId, index));
  }
  if (body.ok === true) return addedItem(body, callId, 0);
  if (body.ok === false) {
    return [{
      kind: "missing",
      key: `${callId}:missing:0`,
      message: serverMessage(body),
    }];
  }
  return [];
}

function addedItem(item: unknown, callId: string, index: number): AssistantCard[] {
  if (!isRecord(item)) return [];
  if (item.ok === false) {
    return [{
      kind: "missing",
      key: `${callId}:missing:${index}`,
      message: serverMessage(item),
    }];
  }
  if (item.ok !== true || typeof item.lineId !== "string" || typeof item.added !== "number") return [];
  const name = typeof item.name === "string" ? item.name : `Added to cart · Qty ${item.added}`;
  const legacy = typeof item.name !== "string";
  return [{
    kind: "added",
    key: `${callId}:added:${index}`,
    additionId: `${callId}:${index}`,
    lineId: item.lineId,
    name,
    packLabel: typeof item.packLabel === "string" ? item.packLabel : null,
    qtyAdded: item.added,
    limitedTo: typeof item.limitedTo === "number" ? item.limitedTo : null,
    legacy,
  }];
}

function choiceCards(callId: string, output: unknown): AssistantCard[] {
  const body = isRecord(output) ? output : {};
  if (body.ok === false) {
    return [{
      kind: "missing",
      key: `${callId}:missing`,
      message: serverMessage(body),
    }];
  }
  const options = Array.isArray(body.options) ? body.options.filter(isRecord) : [];
  const built = options.flatMap((option, index) => {
    if (typeof option.name !== "string" || typeof option.packLabel !== "string") return [];
    if (typeof option.variantId !== "string" || typeof option.listingId !== "string") return [];
    const base = `${option.name} (${option.packLabel})`;
    return [{
      choiceId: `${option.listingId}:${option.variantId}`,
      label: base,
      sendText: base,
      variantId: option.variantId,
      index,
    }];
  });
  const counts = new Map<string, number>();
  for (const option of built) counts.set(option.label, (counts.get(option.label) ?? 0) + 1);
  const choice: ChoiceCard = {
    kind: "choices",
    key: `${callId}:choices`,
    options: built.map((option) => {
      const collided = (counts.get(option.label) ?? 0) > 1;
      const suffix = option.variantId.slice(-4);
      const text = collided ? `${option.label} · ${suffix}` : option.label;
      return { choiceId: option.choiceId, label: text, sendText: text };
    }),
  };
  const cards: AssistantCard[] = built.length > 0 ? [choice] : [];
  const notFound = Array.isArray(body.notFound) ? body.notFound : [];
  if (notFound.length > 0) {
    cards.push({
      kind: "missing",
      key: `${callId}:missing`,
      message: "Some products are not in this store.",
    });
  }
  return cards;
}

function summaryCards(callId: string, output: unknown): AssistantCard[] {
  const body = isRecord(output) ? output : null;
  if (!body || body.ok !== true || typeof body.subtotalCents !== "number") return [];
  const lines = Array.isArray(body.lines) ? body.lines : [];
  const summaryLines: SummaryLine[] = [];
  for (const line of lines) {
    if (!isRecord(line)) continue;
    if (typeof line.lineId !== "string" || typeof line.name !== "string") continue;
    if (typeof line.qty !== "number" || typeof line.lineTotalCents !== "number") continue;
    summaryLines.push({
      lineId: line.lineId,
      name: line.name,
      packLabel: typeof line.packLabel === "string" ? line.packLabel : "",
      qty: line.qty,
      lineTotalCents: line.lineTotalCents,
      lineTotalLabel: money(line.lineTotalCents),
    });
  }
  const missingCents = typeof body.missingCents === "number" ? body.missingCents : 0;
  return [{
    kind: "summary",
    key: `${callId}:summary`,
    lines: summaryLines,
    subtotalCents: body.subtotalCents,
    subtotalLabel: money(body.subtotalCents),
    minimumOrderCents: typeof body.minimumOrderCents === "number" ? body.minimumOrderCents : 0,
    minimumMet: body.minimumMet === true,
    missingCents,
    missingLabel: money(missingCents),
    gapLabel: missingCents > 0
      ? `${money(missingCents)} to reach the ${money(typeof body.minimumOrderCents === "number" ? body.minimumOrderCents : 0)} minimum order`
      : null,
  }];
}

function serverMessage(body: Record<string, unknown>): string {
  if (typeof body.message === "string" && body.message.trim() && !looksLikeRawId(body.message)) {
    return body.message;
  }
  return "That did not work.";
}

function looksLikeRawId(value: string): boolean {
  return /^[a-z0-9_-]{16,}$/i.test(value.trim());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
