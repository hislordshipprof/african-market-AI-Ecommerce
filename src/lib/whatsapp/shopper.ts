import type { LanguageModel, UIMessage, UIMessageChunk } from "ai";
import { lockWhatsAppShopper, platform, storeScopedTransaction } from "../db";
import { MAX_TEXT } from "../assistant/attachments";
import { openAssistant, runShopperTurn } from "../assistant/chat-handler";
import { assistantChatEnabled } from "../assistant/contract";
import { money } from "../format";
import { storePageUrl } from "../notifications/tracking-url";
import { takeRateLimit } from "../rate-limit/app-limiter";
import { checkoutLinkPath, createCheckoutLink } from "./checkout-link";
import { messageRef } from "./code";
import { whatsappErrorCode } from "./errors";
import { getWhatsAppProvider } from "./index";
import { storeWhatsAppSender } from "./store-number";
import { shopperSenderKey } from "./token-box";
import type { ListRow, OutboundMessage } from "./types";
import type { InboundMessage } from "./webhook-payload";

export const TYPE_YOUR_LIST_REPLY = "Please type your list for now. Photos and voice notes are not read yet.";
export const TOO_LONG_REPLY = `Please send a shorter message, up to ${MAX_TEXT} characters.`;
export const SHOPPER_TURNS_PER_HOUR = 30;

const HOUR_MS = 60 * 60 * 1000;
const WINDOW_MS = 24 * HOUR_MS;
const WA_ID = /^\d{8,15}$/;
const MEDIA = new Set(["image", "audio", "video", "document", "sticker"]);
const FIXED_ERROR = "Sorry, something went wrong. Please try again.";
const MAX_ROWS = 10;

export interface ShopperOptions {
  /** Test seam: the model the turn runs on. */
  model?: LanguageModel;
  now?: () => Date;
}

/** The previous turn on this cart is still running. The caller releases the message so Meta redelivers it. */
export class ShopperTurnBusyError extends Error {
  constructor() {
    super("The previous WhatsApp turn is still running");
    this.name = "ShopperTurnBusyError";
  }
}

function log(event: string, storeId: string, message: InboundMessage, extra: Record<string, string | number> = {}): void {
  console.info(JSON.stringify({ event, storeId, message: messageRef(message.id), type: message.type, ...extra }));
}

/** Meta's customer-service window: 24 hours from the customer's message. A message with no send time is outside it. */
function insideWindow(message: InboundMessage, at: Date): boolean {
  return message.timestamp !== null && at.getTime() - message.timestamp * 1000 < WINDOW_MS;
}

/**
 * A customer's message to the store's own number (#559) runs the shopper
 * assistant: the same turn, tools, grounding, spend cap and monthly chat cap
 * as the web chat, on a store-scoped cart keyed by an HMAC of the sender. The
 * number is used only as the reply address; it never enters the turn.
 */
export async function handleShopperMessage(
  input: { storeId: string; message: InboundMessage },
  options: ShopperOptions = {},
): Promise<void> {
  const now = options.now ?? (() => new Date());
  const { storeId, message } = input;
  const at = now();
  const to = message.from ?? "";
  if (!WA_ID.test(to)) return log("whatsapp_shopper_unaddressable", storeId, message);
  if (!insideWindow(message, at)) return log("whatsapp_shopper_outside_window", storeId, message);

  const text = (message.type === "text" ? message.text : message.type === "interactive" ? message.replyId : null)?.trim() ?? "";
  const media = MEDIA.has(message.type);
  if (!media && !text) return log("whatsapp_shopper_ignored", storeId, message);
  if (!assistantChatEnabled()) return log("whatsapp_shopper_disabled", storeId, message);

  const store = await platform.store.findUnique({ where: { id: storeId } });
  if (!store || store.status === "suspended") return log("whatsapp_shopper_store_unavailable", storeId, message);
  const senderKey = shopperSenderKey(storeId, to);
  if (!senderKey) return log("whatsapp_token_key_missing", storeId, message);

  const limit = await takeRateLimit(`assistant:wa:${storeId}:${senderKey}`, SHOPPER_TURNS_PER_HOUR, HOUR_MS, at.getTime());
  if (!limit.ok) return log("whatsapp_shopper_rate_limited", storeId, message);

  const reply = (messages: OutboundMessage[]) => sendReplies(storeId, message, messages, now);
  if (media) return reply([{ type: "text", to, body: TYPE_YOUR_LIST_REPLY }]);
  if (text.length > MAX_TEXT) return reply([{ type: "text", to, body: TOO_LONG_REPLY }]);

  const gate = await openAssistant(at, options.model);
  if (!gate.ok) return reply([{ type: "text", to, body: gate.message }]);

  const cartId = await shopperCartId(storeId, senderKey);
  const outcome = await runShopperTurn({
    store,
    cartId,
    userId: null,
    // A wamid can embed the sender's number, so the turn id is its digest.
    turnId: `wa-${messageRef(message.id)}`,
    text,
    files: [],
    replayOnly: false,
    model: gate.model,
    modelId: gate.modelId,
    at,
  }, { now });
  if (outcome.kind === "error") {
    if (outcome.code === "assistant_busy") throw new ShopperTurnBusyError();
    return reply([{ type: "text", to, body: outcome.message }]);
  }
  const turn = outcome.kind === "replay" ? fromMessage(outcome.message) : await readTurn(outcome.stream);
  return reply(await outboundFor(turn, { store, cartId, to, at }));
}

/** The sender's open cart at this store, or a new one. A cart an account has since claimed is not reused. */
async function shopperCartId(storeId: string, senderKey: string): Promise<string> {
  return storeScopedTransaction(storeId, async (tx) => {
    await lockWhatsAppShopper(tx, storeId, senderKey);
    const row = await tx.whatsAppShopperCart.findUnique({
      where: { storeId_senderKey: { storeId, senderKey } },
      include: { cart: { select: { userId: true } } },
    });
    if (row && row.cart.userId === null) return row.cartId;
    const cart = await tx.cart.create({ data: { storeId, userId: null, customerId: null, source: "manual" } });
    await tx.whatsAppShopperCart.upsert({
      where: { storeId_senderKey: { storeId, senderKey } },
      create: { storeId, senderKey, cartId: cart.id },
      update: { cartId: cart.id },
    });
    return cart.id;
  });
}

interface TurnResult {
  texts: string[];
  tools: Array<{ name: string; output: unknown }>;
}

/** Reads the turn's stream to the end (the transcript is saved when it ends): grounded text and tool outputs. */
async function readTurn(stream: ReadableStream<UIMessageChunk>): Promise<TurnResult> {
  const texts = new Map<string, string>();
  const names = new Map<string, string>();
  const tools: TurnResult["tools"] = [];
  let failed = false;
  const reader = stream.getReader();
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    const chunk = next.value;
    if (chunk.type === "text-delta") texts.set(chunk.id, (texts.get(chunk.id) ?? "") + chunk.delta);
    else if (chunk.type === "tool-input-available") names.set(chunk.toolCallId, chunk.toolName);
    else if (chunk.type === "tool-output-available") {
      tools.push({ name: names.get(chunk.toolCallId) ?? "", output: chunk.output });
    } else if (chunk.type === "error") failed = true;
  }
  const said = [...texts.values()].filter((text) => text.trim() !== "");
  return { texts: said.length === 0 && failed ? [FIXED_ERROR] : said, tools };
}

function fromMessage(message: UIMessage): TurnResult {
  const result: TurnResult = { texts: [], tools: [] };
  for (const part of message.parts) {
    if (part.type === "text" && part.text.trim() !== "") result.texts.push(part.text);
    if (part.type.startsWith("tool-") && "output" in part) {
      result.tools.push({ name: part.type.slice("tool-".length), output: part.output });
    }
  }
  return result;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function list(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.flatMap((item) => (record(item) ? [record(item)!] : [])) : [];
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

interface Choice {
  name: string;
  packLabel: string;
  priceCents: number;
  variantId: string;
}

/** Choices from the last offer_choices or show_products result, as the web chat draws its chips and cards. */
function choicesFrom(tools: TurnResult["tools"]): Choice[] {
  for (const { name, output } of [...tools].reverse()) {
    const body = record(output);
    if (!body || body.ok !== true) continue;
    if (name === "offer_choices") {
      return list(body.options).flatMap((option) => (
        typeof option.name === "string" && typeof option.packLabel === "string"
          && typeof option.priceCents === "number" && typeof option.variantId === "string"
          ? [{ name: option.name, packLabel: option.packLabel, priceCents: option.priceCents, variantId: option.variantId }]
          : []
      ));
    }
    if (name === "show_products") {
      return list(body.cards).flatMap((card) => (typeof card.name !== "string" ? [] : list(card.variants).flatMap((variant) => (
        typeof variant.label === "string" && typeof variant.priceCents === "number" && typeof variant.variantId === "string"
          ? [{ name: card.name as string, packLabel: variant.label, priceCents: variant.priceCents, variantId: variant.variantId }]
          : []
      ))));
    }
  }
  return [];
}

/** A row's id is what the customer "says" by tapping it: the same words a web Choice chip sends. */
function rowsFor(choices: Choice[]): ListRow[] {
  const picked = choices.slice(0, MAX_ROWS);
  const sends = picked.map((choice) => `${choice.name} (${choice.packLabel})`);
  return picked.map((choice, index) => {
    const send = sends.filter((value) => value === sends[index]).length > 1
      ? `${sends[index]} · ${choice.variantId.slice(-4)}`
      : sends[index];
    return {
      id: clip(send, 200),
      title: clip(choice.name, 24),
      description: clip(`${choice.packLabel} · ${money(choice.priceCents)}`, 72),
    };
  });
}

/** WhatsApp bold is one asterisk. */
function whatsappText(text: string): string {
  return text.replace(/\*\*(.+?)\*\*/g, "*$1*");
}

async function reviewMessage(
  output: Record<string, unknown>,
  context: { store: { id: string; slug: string; name: string }; cartId: string; at: Date },
): Promise<string> {
  const lines = list(output.lines).flatMap((line) => (
    typeof line.name === "string" && typeof line.qty === "number" && typeof line.lineTotalCents === "number"
      ? [`${line.qty} × ${line.name}${typeof line.packLabel === "string" ? ` (${line.packLabel})` : ""}: ${money(line.lineTotalCents)}`]
      : []
  ));
  const fulfillment = record(output.fulfillment);
  const amount = (key: string) => (typeof output[key] === "number" ? output[key] as number : 0);
  const body = [`Your order at ${context.store.name}:`, ...lines];
  if (typeof fulfillment?.slotLabel === "string") body.push(`Pickup: ${fulfillment.slotLabel}`);
  if (amount("serviceFeeCents") > 0) body.push(`Service fee: ${money(amount("serviceFeeCents"))}`);
  if (amount("taxCents") > 0) body.push(`Tax: ${money(amount("taxCents"))}`);
  body.push(`Total: ${money(amount("totalCents"))}`);
  if (amount("holdCents") > amount("totalCents")) body.push(`Your card is held for up to ${money(amount("holdCents"))}.`);
  for (const problem of Array.isArray(output.problems) ? output.problems : []) {
    if (typeof problem === "string") body.push(problem);
  }
  const token = await createCheckoutLink(context.store.id, context.cartId, context.at);
  const url = storePageUrl(context.store, checkoutLinkPath(token), process.env);
  body.push("");
  if (url) {
    body.push(`Review and pay: ${url}`);
    body.push("The link works once and for 60 minutes. Nothing is ordered until you pay on that page.");
  } else {
    body.push("Open the store's website to review and pay.");
  }
  return body.join("\n");
}

async function outboundFor(
  turn: TurnResult,
  context: { store: { id: string; slug: string; name: string }; cartId: string; to: string; at: Date },
): Promise<OutboundMessage[]> {
  const { to } = context;
  const out: OutboundMessage[] = [];
  const text = clip(whatsappText(turn.texts.join("\n\n").trim()), 4096);
  const rows = rowsFor(choicesFrom(turn.tools));
  if (rows.length > 0) out.push({ type: "list", to, body: text || "Pick one.", button: "Choose", rows });
  else if (text) out.push({ type: "text", to, body: text });
  const review = [...turn.tools].reverse().find((tool) => tool.name === "prepare_checkout" && record(tool.output)?.ok === true);
  if (review) out.push({ type: "text", to, body: await reviewMessage(record(review.output)!, context) });
  return out;
}

/** From the store's own number, only inside the window. A failed send is logged and not retried. */
async function sendReplies(
  storeId: string,
  message: InboundMessage,
  messages: OutboundMessage[],
  now: () => Date,
): Promise<void> {
  if (messages.length === 0) return;
  const sender = await storeWhatsAppSender(storeId);
  if (!sender) return log("whatsapp_shopper_no_sender", storeId, message);
  for (const outbound of messages) {
    if (!insideWindow(message, now())) return log("whatsapp_shopper_outside_window", storeId, message);
    try {
      await getWhatsAppProvider().send(outbound, sender);
    } catch (error) {
      return log("whatsapp_shopper_reply_failed", storeId, message, { code: whatsappErrorCode(error) });
    }
  }
}
