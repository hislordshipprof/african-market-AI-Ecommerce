import { WhatsAppApiError } from "./errors";
import { APPROVED_TEMPLATES, OWNER_LINK_TEMPLATE } from "./templates";
import type { OutboundMessage, SendResult, WhatsAppProvider } from "./types";

/**
 * Recording fake for tests and E2E_FAKE_WHATSAPP=1. It enforces the Cloud API
 * rules this platform depends on, with Meta's error codes:
 * - free-form messages (text, interactive, media) only within 24 hours of the
 *   recipient's last inbound message (131047);
 * - text body 1–4096 characters; interactive body 1–1024, 1–3 reply buttons,
 *   titles 1–20 characters, ids 1–256 and unique (131009);
 * - templates only by an approved name and language (132001), and the
 *   owner_link_code template with exactly a body code and a copy-code button
 *   code of at most 15 characters (132000).
 */

const WINDOW_MS = 24 * 60 * 60 * 1000;

export interface FakeOutboxEntry {
  message: OutboundMessage;
  result: SendResult;
}

const outbox: FakeOutboxEntry[] = [];
const lastInbound = new Map<string, number>();
let sequence = 0;

function digits(to: string): string {
  return to.replace(/^\+/, "");
}

function invalid(code: number): never {
  throw new WhatsAppApiError(code, 400);
}

function checkWindow(to: string, now: number): void {
  const at = lastInbound.get(digits(to));
  if (at === undefined || now - at > WINDOW_MS) invalid(131047);
}

function checkTemplate(message: Extract<OutboundMessage, { type: "template" }>): void {
  const approved = APPROVED_TEMPLATES.some(
    (template) => template.name === message.name && template.language === message.language,
  );
  if (!approved) throw new WhatsAppApiError(132001, 404);
  if (message.name !== OWNER_LINK_TEMPLATE.name) return;
  const components = message.components ?? [];
  const body = components.find((component) => component.type === "body");
  const button = components.find((component) => component.type === "button");
  if (components.length !== 2 || !body || !button) invalid(132000);
  if (body.parameters.length !== 1 || !body.parameters[0].text) invalid(132000);
  if (button.sub_type !== "url" || button.index !== "0") invalid(132000);
  if (button.parameters.length !== 1) invalid(132000);
  const code = button.parameters[0].text;
  if (!code || code.length > 15) invalid(132000);
}

function check(message: OutboundMessage, now: number): void {
  if (!/^\d{8,15}$/.test(digits(message.to))) invalid(131009);
  switch (message.type) {
    case "text":
      checkWindow(message.to, now);
      if (message.body.length < 1 || message.body.length > 4096) invalid(131009);
      return;
    case "interactive": {
      checkWindow(message.to, now);
      if (message.body.length < 1 || message.body.length > 1024) invalid(131009);
      const { buttons } = message;
      if (buttons.length < 1 || buttons.length > 3) invalid(131009);
      const ids = new Set(buttons.map((button) => button.id));
      if (ids.size !== buttons.length) invalid(131009);
      for (const button of buttons) {
        if (button.title.length < 1 || button.title.length > 20) invalid(131009);
        if (button.id.length < 1 || button.id.length > 256) invalid(131009);
      }
      return;
    }
    case "media":
      checkWindow(message.to, now);
      if (!message.link.startsWith("https://")) invalid(131009);
      return;
    case "template":
      checkTemplate(message);
      return;
  }
}

export const fakeWhatsAppProvider: WhatsAppProvider = {
  // Records synchronously before returning, so a caller that started the send
  // and did not await it still finds the entry.
  send(message) {
    try {
      check(message, Date.now());
    } catch (error) {
      return Promise.reject(error);
    }
    sequence += 1;
    const result: SendResult = { messageId: `wamid.fake-${sequence}`, waId: digits(message.to) };
    outbox.push({ message, result });
    return Promise.resolve(result);
  },
};

/** Meta opens the 24-hour window when the user writes to the business. */
export function noteInbound(waId: string, at: number = Date.now()): void {
  lastInbound.set(digits(waId), at);
}

export function getFakeOutbox(): readonly FakeOutboxEntry[] {
  return outbox;
}

export function resetFake(): void {
  outbox.length = 0;
  lastInbound.clear();
}
