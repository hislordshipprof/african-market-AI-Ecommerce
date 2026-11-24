import { orderStatusLabel } from "../order/status-labels";
import { quotedFrom, stripHeaderChars } from "../email/from";
import { escapeHtml, formatUsPhone, money, telHref } from "../format";
import { storeContact, type StoreContactFields } from "../order/delivery-address";
import { fulfilledStatus } from "../order/constants";
import { scheduledTimeLabel } from "../order/pickup-slots";
import type { PushMessage } from "../push/sender";
import { presetPrimary, readableFillColor } from "../theme";
import { ORDER_UPDATE_TEMPLATES, orderUpdateMessage } from "../whatsapp/templates";
import type { OutboundMessage, WhatsAppSender } from "../whatsapp/types";
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
  storeId: string;
  number: number;
  status: string;
  fulfillment: string;
  subtotalCents: number;
  tipCents: number;
  deliveryFeeCents: number;
  serviceFeeCents: number;
  discountCents: number;
  coupon: { code: string } | null;
  totalAuthorizedCents: number;
  capturedAmountCents: number | null;
  refundId: string | null;
  prepEstimateMinutes: number | null;
  acceptedAt: Date | null;
  /** The booked slot's start, a UTC ISO instant (#565); null for ASAP and on-demand orders. */
  pickupSlot?: string | null;
  trackingToken: string | null;
  /** A shipped order's carrier, tracking number and the carrier's tracking page (#568). */
  shippingCarrier?: string | null;
  shippingTrackingNumber?: string | null;
  shippingTrackingUrl?: string | null;
  customer: { name: string; email: string | null; phone: string | null };
  store: {
    name: string;
    slug: string;
    logoUrl: string | null;
    brandColor: string | null;
    themePreset: string;
    timezone: string;
  } & Partial<StoreContactFields>;
  lines: NotifyLine[];
  manualResolution: { refundedCents: number; repaidCents: number; capturedCents: number } | null;
  /** Set only when the customer opted in to WhatsApp updates at checkout (#560). */
  whatsapp?: {
    /** The store's registered number; null when it has none now or its token cannot be opened. */
    sender: WhatsAppSender | null;
    /** The customer sent STOP to this store's number. */
    optedOut: boolean;
  } | null;
};

const HEX = /^#[0-9a-fA-F]{6}$/;
const loggedTimezones = new Set<string>();
const loggedMissingCapture = new Set<string>();

export function smsStoreName(name: string): string {
  const mapped = name
    .replace(/[\u2018\u2019\u2032]/g, "'")
    .replace(/[\u201C\u201D\u2033]/g, '"')
    .replace(/\s+/g, " ")
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .trim();
  return Array.from(mapped).slice(0, 40).join("");
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

export function statusForEvent(event: Exclude<OrderNotifyEvent, "store_replied" | "substitution">, fulfillment: string): string {
  switch (event) {
    case "placed":
      return "AUTHORIZED";
    case "accepted":
      return "ACCEPTED";
    case "ready":
      return fulfilledStatus(fulfillment);
    case "out_for_delivery":
      return "OUT_FOR_DELIVERY";
    case "shipped":
      return "SHIPPED";
    case "in_transit":
      return "IN_TRANSIT";
    case "delivered":
      return "DELIVERED";
    case "completed":
      return "COMPLETED";
    case "cancelled":
      return "CANCELLED";
    case "refunded":
      return "REFUNDED";
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
const CHARGED_EVENTS: ReadonlySet<OrderNotifyEvent> = new Set(["ready", "out_for_delivery", "shipped", "in_transit", "delivered", "completed"]);

/** The carrier's tracking page, on each parcel update of a shipped order (#568). */
function carrierLink(order: NotifyOrder, event: OrderNotifyEvent): string | null {
  if (order.fulfillment !== "ship" || !["shipped", "in_transit", "delivered"].includes(event)) return null;
  const url = order.shippingTrackingUrl;
  if (!url) return null;
  try {
    return new URL(url).protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/** Where a pickup order is collected, on its confirmation and when it is ready (#783). */
function pickupPlace(order: NotifyOrder, event: OrderNotifyEvent): string {
  if (order.fulfillment !== "pickup" || (event !== "placed" && event !== "ready")) return "";
  const { address, phone, hours } = storeContact({
    addressLine1: order.store.addressLine1 ?? null,
    addressLine2: order.store.addressLine2 ?? null,
    city: order.store.city ?? null,
    state: order.store.state ?? null,
    zip: order.store.zip ?? null,
    phone: order.store.phone ?? null,
    hours: order.store.hours ?? null,
  });
  const parts: string[] = [];
  if (address) parts.push(`<p><strong>Pick up at ${escapeHtml(address)}</strong></p>`);
  if (phone) parts.push(`<p>Call the store: <a href="${escapeHtml(telHref(phone))}">${escapeHtml(formatUsPhone(phone))}</a></p>`);
  if (hours.length) parts.push(`<p>${hours.map((line) => escapeHtml(`${line.day} ${line.text}`)).join("<br />")}</p>`);
  return parts.join("");
}

function promoLine(order: NotifyOrder): string {
  if (order.discountCents <= 0) return "";
  const label = order.coupon ? `Promo ${order.coupon.code}` : "Promo discount";
  return `<p>${escapeHtml(label)}: −${escapeHtml(money(order.discountCents))}.</p>`;
}

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
  push?: { storeId: string; orderId: string; message: PushMessage };
  whatsapp?: { message: OutboundMessage; sender: WhatsAppSender };
};

/** The subject and first line: the order status, or that the store answered the customer's message. */
function headline(order: NotifyOrder, event: OrderNotifyEvent): string {
  if (event === "store_replied") return "The store replied";
  if (event === "substitution") return "An item is short: choose a swap or a refund";
  // A refund can be part of the order, so its message never reads as the order status.
  if (event === "refunded") return "Refund issued";
  return orderStatusLabel(statusForEvent(event, order.fulfillment), order.fulfillment);
}

export function renderEmail(order: NotifyOrder, event: OrderNotifyEvent, url: string, fromAddress: string): RenderedMessage {
  const status = headline(order, event);
  const storeName = order.store.name;
  const color = headerColor(order.store);
  const ink = readableFillColor(color);
  const logo = httpsLogo(order.store.logoUrl);
  const subject = stripHeaderChars(`${storeName} order #${order.number}: ${status}`);
  // A scheduled order is ready at its slot, not prep minutes after acceptance (#571).
  const scheduled = event === "placed" || event === "accepted" ? scheduledTimeLabel(order.pickupSlot ?? null, order.store.timezone) : null;
  const around = event === "accepted" && !scheduled ? readyAround(order) : null;
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
  if (scheduled) parts.push(`<p>Scheduled for ${escapeHtml(scheduled)}.</p>`);
  if (around) parts.push(`<p>Ready around ${escapeHtml(around)}.</p>`);
  parts.push(pickupPlace(order, event));
  if (event !== "cancelled" && event !== "store_replied" && event !== "refunded" && event !== "substitution") parts.push(`<ul>${lineRows(order, event)}</ul>`);
  if (event === "placed" || event === "accepted") {
    const estimate = order.subtotalCents - order.discountCents + order.serviceFeeCents + order.tipCents + order.deliveryFeeCents;
    parts.push(promoLine(order));
    if (order.serviceFeeCents > 0) parts.push(`<p>Service fee ${escapeHtml(money(order.serviceFeeCents))}.</p>`);
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
      parts.push(promoLine(order));
      if (order.serviceFeeCents > 0) parts.push(`<p>Service fee ${escapeHtml(money(order.serviceFeeCents))}.</p>`);
      parts.push(`<p>Charged ${escapeHtml(money(order.capturedAmountCents))}.</p>`);
    }
  } else if (event === "cancelled") {
    parts.push(`<p>${escapeHtml(cancelCopy(order))}</p>`);
  } else if (event === "refunded") {
    parts.push(`<p>Your refund is on its way to your card. Banks usually take 5 to 10 business days to show it.</p>`);
  } else if (event === "substitution") {
    parts.push(`<p>The store could not find everything you ordered. You have 10 minutes to choose; after that your swap preference applies.</p>`);
  }
  const linkText = event === "store_replied" ? "Read the reply" : event === "substitution" ? "Choose now" : "Track your order";
  parts.push(`<p><a href="${escapeHtml(url)}" style="display:inline-block;background:${escapeHtml(color)};color:${ink};padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:bold">${linkText}</a></p>`);
  const carrier = carrierLink(order, event);
  if (carrier) parts.push(`<p>Carrier tracking: <a href="${escapeHtml(carrier)}">${escapeHtml(order.shippingCarrier ?? "carrier")} ${escapeHtml(order.shippingTrackingNumber ?? "")}</a></p>`);
  parts.push(`</div>`);
  parts.push(`<p style="font-size:12px">Powered by the Platform</p>`);
  return {
    to: order.customer.email ?? "",
    from: quotedFrom(storeName, fromAddress),
    subject,
    html: parts.join(""),
  };
}

/** A lock-screen line: the store's name and the status, never money or items. */
export function renderPush(order: NotifyOrder, event: OrderNotifyEvent, url: string): RenderedMessage {
  const body = `Order #${order.number}: ${headline(order, event)}`;
  return {
    to: order.id,
    push: { storeId: order.storeId, orderId: order.id, message: { title: order.store.name, body, url, tag: `order-${order.number}` } },
  };
}

export function renderSms(order: NotifyOrder, event: OrderNotifyEvent, url: string): RenderedMessage {
  const name = smsStoreName(order.store.name);
  if (event === "store_replied") {
    return { to: order.customer.phone ?? "", text: `${name}: The store replied about order #${order.number}. Read it: ${url}` };
  }
  if (event === "substitution") {
    return { to: order.customer.phone ?? "", text: `${name}: an item in order #${order.number} is short. Choose a swap or refund within 10 min: ${url}` };
  }
  const status = headline(order, event);
  const carrier = carrierLink(order, event);
  let text = carrier
    ? `${name}: order #${order.number} ${status}. Carrier tracking: ${carrier}`
    : `${name}: order #${order.number} ${status}. Track it: ${url}`;
  if (event === "placed") text += " Reply STOP to opt out.";
  return { to: order.customer.phone ?? "", text };
}

type WhatsAppEvent = Exclude<OrderNotifyEvent, "store_replied" | "shipped" | "in_transit">;

function whatsappTemplate(order: NotifyOrder, event: WhatsAppEvent) {
  if (event === "ready") {
    return order.fulfillment === "pickup" ? ORDER_UPDATE_TEMPLATES.ready_pickup : ORDER_UPDATE_TEMPLATES.ready_delivery;
  }
  return ORDER_UPDATE_TEMPLATES[event];
}

/**
 * The order-update template (#560): the store name and the tracking link only.
 * The link's path after the store's host is the button's URL suffix; null when
 * the link has no path to carry.
 */
export function renderWhatsApp(
  order: NotifyOrder,
  event: WhatsAppEvent,
  url: string,
  to: string,
  sender: WhatsAppSender,
): RenderedMessage | null {
  const origin = new URL(url).origin;
  const suffix = url.startsWith(`${origin}/`) ? url.slice(origin.length + 1) : "";
  if (!suffix) return null;
  const message = orderUpdateMessage(to, whatsappTemplate(order, event), smsStoreName(order.store.name), suffix);
  return { to, from: sender.phoneNumberId, whatsapp: { message, sender } };
}
