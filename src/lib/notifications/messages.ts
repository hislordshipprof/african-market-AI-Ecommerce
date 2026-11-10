import { customerStatusLabel } from "../customer-account/order-history-view";
import { presetPrimary } from "../theme";
import type { OrderNotifyEvent } from "./record";

export type NotifyLine = {
  status: string;
  qtyOrdered: number;
  qtyPicked: number;
  unitPriceCents: number;
  listingVariant: {
    label: string;
    listing: { customName: string | null; masterProduct: { name: string } | null };
  };
  substituteVariant: {
    label: string;
    listing: { customName: string | null; masterProduct: { name: string } | null };
  } | null;
};

export type NotifyOrder = {
  id: string;
  number: number;
  status: string;
  fulfillment: string;
  subtotalCents: number;
  tipCents: number;
  deliveryFeeCents: number;
  totalAuthorizedCents: number;
  capturedAmountCents: number | null;
  refundId: string | null;
  prepEstimateMinutes: number | null;
  acceptedAt: Date | null;
  trackingToken: string | null;
  customer: { name: string; email: string | null; phone: string | null };
  store: {
    name: string;
    slug: string;
    logoUrl: string | null;
    brandColor: string | null;
    themePreset: string;
    timezone: string;
  };
  lines: NotifyLine[];
  manualResolution: { refundedCents: number; repaidCents: number; capturedCents: number } | null;
};

const HEX = /^#[0-9a-fA-F]{6}$/;
const loggedTimezones = new Set<string>();
const loggedMissingCapture = new Set<string>();

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function stripHeaderChars(value: string): string {
  return value.replace(/["\\]/g, "").replace(/[\u0000-\u001F\u007F]/g, "").trim();
}

/** RFC 5322 quoted display name so a comma or parenthesis is not a second address. */
export function quotedFrom(storeName: string, fromAddress: string): string {
  const wrapped = fromAddress.match(/<([^>]+)>/);
  const address = (wrapped?.[1] ?? fromAddress).trim();
  const name = stripHeaderChars(storeName);
  if (!name) return address;
  return `"${name}" <${address}>`;
}

export function smsStoreName(name: string): string {
  const mapped = name
    .replace(/[\u2018\u2019\u2032]/g, "'")
    .replace(/[\u201C\u201D\u2033]/g, '"')
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return Array.from(mapped).slice(0, 40).join("");
}

function money(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

function onFill(hex: string): string {
  const channel = (start: number) => {
    const s = parseInt(hex.slice(start, start + 2), 16) / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
  const white = 1.05 / (luminance + 0.05);
  const black = (luminance + 0.05) / 0.05;
  return white >= black ? "#FFFFFF" : "#0B0B0B";
}

export function headerColor(store: NotifyOrder["store"]): string {
  if (store.brandColor && HEX.test(store.brandColor)) return store.brandColor;
  return presetPrimary(store.themePreset);
}

export function httpsLogo(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

/** Pickup is Awaiting pickup. Delivery is Ready. Matches fulfilledStatus(). */
export function statusForEvent(event: Exclude<OrderNotifyEvent, "store_replied">, fulfillment: string): string {
  switch (event) {
    case "placed":
      return "AUTHORIZED";
    case "accepted":
      return "ACCEPTED";
    case "ready":
      return fulfillment === "pickup" ? "AWAITING_PICKUP" : "READY";
    case "out_for_delivery":
      return "OUT_FOR_DELIVERY";
    case "delivered":
      return "DELIVERED";
    case "completed":
      return "COMPLETED";
    case "cancelled":
      return "CANCELLED";
  }
}

function variantName(variant: NotifyLine["listingVariant"] | null | undefined): string {
  if (!variant) return "Item";
  return variant.listing.customName?.trim()
    || variant.listing.masterProduct?.name?.trim()
    || variant.label;
}

function lineLabel(line: NotifyLine, picked: boolean): string {
  if (picked && line.status === "substituted" && line.substituteVariant) {
    return variantName(line.substituteVariant);
  }
  return variantName(line.listingVariant);
}

function readyAround(order: NotifyOrder): string | null {
  if (!order.acceptedAt || order.prepEstimateMinutes == null) return null;
  const ready = new Date(order.acceptedAt.getTime() + order.prepEstimateMinutes * 60_000);
  const requested = order.store.timezone || "America/New_York";
  let zone = requested;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone }).format(ready);
  } catch {
    if (!loggedTimezones.has(requested)) {
      loggedTimezones.add(requested);
      console.error(JSON.stringify({
        event: "notification_timezone_invalid",
        orderId: order.id,
        reason: "invalid_timezone",
      }));
    }
    zone = "America/New_York";
  }
  const dayKey = (date: Date) => new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hour: "numeric",
    minute: "2-digit",
  }).format(ready);
  if (dayKey(order.acceptedAt) === dayKey(ready)) return time;
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "long" }).format(ready);
  return `${weekday} ${time}`;
}

function cancelCopy(order: NotifyOrder): string {
  const manual = order.manualResolution;
  if (manual && manual.refundedCents + manual.repaidCents < manual.capturedCents) {
    return "The store has resolved your refund. Contact the store if you need help.";
  }
  if (order.capturedAmountCents == null && !order.refundId) {
    return "You were not charged, and your card hold was released.";
  }
  return "Your payment has been refunded.";
}

/** Events after capture: the order is picked and the final amount is charged. */
const CHARGED_EVENTS: ReadonlySet<OrderNotifyEvent> = new Set(["ready", "out_for_delivery", "delivered", "completed"]);

function lineRows(order: NotifyOrder, event: OrderNotifyEvent): string {
  const picked = CHARGED_EVENTS.has(event);
  return order.lines.map((line) => {
    const name = escapeHtml(lineLabel(line, picked));
    if (picked && (line.status === "refunded" || line.qtyPicked === 0)) {
      return `<li>${name} — not charged</li>`;
    }
    const qty = picked ? line.qtyPicked : line.qtyOrdered;
    return `<li>${qty} × ${name} — ${escapeHtml(money(qty * line.unitPriceCents))}</li>`;
  }).join("");
}

export type RenderedMessage = {
  to: string;
  from?: string;
  subject?: string;
  html?: string;
  text?: string;
};

/** The subject and first line: the order status, or that the store answered the customer's message. */
function headline(order: NotifyOrder, event: OrderNotifyEvent): string {
  if (event === "store_replied") return "The store replied";
  return customerStatusLabel(statusForEvent(event, order.fulfillment));
}

export function renderEmail(order: NotifyOrder, event: OrderNotifyEvent, url: string, fromAddress: string): RenderedMessage {
  const status = headline(order, event);
  const storeName = order.store.name;
  const color = headerColor(order.store);
  const ink = onFill(color);
  const logo = httpsLogo(order.store.logoUrl);
  const subject = stripHeaderChars(`${storeName} order #${order.number}: ${status}`);
  const around = event === "accepted" ? readyAround(order) : null;
  const parts: string[] = [];
  parts.push(`<div style="background:${escapeHtml(color)};color:${ink};padding:16px 20px">`);
  if (logo) {
    parts.push(`<img src="${escapeHtml(logo)}" alt="" width="48" height="48" />`);
  }
  parts.push(`<strong>${escapeHtml(storeName)}</strong></div>`);
  parts.push(`<div style="padding:20px;font-family:Georgia,serif;color:#15201A">`);
  if (order.customer.name.trim()) {
    parts.push(`<p>Hello ${escapeHtml(order.customer.name.trim())},</p>`);
  }
  parts.push(`<p>${escapeHtml(status)}. Order #${order.number}.</p>`);
  if (around) parts.push(`<p>Ready around ${escapeHtml(around)}.</p>`);
  if (event !== "cancelled" && event !== "store_replied") parts.push(`<ul>${lineRows(order, event)}</ul>`);
  if (event === "placed" || event === "accepted") {
    const estimate = order.subtotalCents + order.tipCents + order.deliveryFeeCents;
    parts.push(`<p>Estimated total ${escapeHtml(money(estimate))}.</p>`);
    parts.push(`<p>Card hold ${escapeHtml(money(order.totalAuthorizedCents))}. You'll be charged the final amount after picking.</p>`);
  } else if (CHARGED_EVENTS.has(event)) {
    if (order.capturedAmountCents == null) {
      if (!loggedMissingCapture.has(order.id)) {
        loggedMissingCapture.add(order.id);
        console.error(JSON.stringify({
          event: "notification_capture_missing",
          orderId: order.id,
          reason: "capture_missing",
        }));
      }
    } else {
      parts.push(`<p>Charged ${escapeHtml(money(order.capturedAmountCents))}.</p>`);
    }
  } else if (event === "cancelled") {
    parts.push(`<p>${escapeHtml(cancelCopy(order))}</p>`);
  }
  const linkText = event === "store_replied" ? "Read the reply" : "Track your order";
  parts.push(`<p><a href="${escapeHtml(url)}">${linkText}</a></p>`);
  parts.push(`</div>`);
  parts.push(`<p style="font-size:12px">Powered by the Platform</p>`);
  return {
    to: order.customer.email ?? "",
    from: quotedFrom(storeName, fromAddress),
    subject,
    html: parts.join(""),
  };
}

export function renderSms(order: NotifyOrder, event: OrderNotifyEvent, url: string): RenderedMessage {
  const name = smsStoreName(order.store.name);
  if (event === "store_replied") {
    return { to: order.customer.phone ?? "", text: `${name}: The store replied about order #${order.number}. Read it: ${url}` };
  }
  const status = customerStatusLabel(statusForEvent(event, order.fulfillment));
  let text = `${name}: order #${order.number} ${status}. Track it: ${url}`;
  if (event === "placed") text += " Reply STOP to opt out.";
  return { to: order.customer.phone ?? "", text };
}
