import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { readStoreCheckoutShift } from "../../db";
import { computeQuote } from "../../checkout/quote";
import type { Contact } from "../../customer-flow/contracts";
import { mayBeUnavailable } from "../tools/availability";
import { offerPickupSlots, slotStillOffered } from "./slots";

export interface CanonicalLine {
  variantId: string;
  qty: number;
  price: number;
  swapRule: string;
  substituteVariantId: string | null;
  maxPerOrder: number | null;
  mayBeUnavailable: boolean;
  active: boolean;
  stockMode: string;
  stockQty: number | null;
  stockStatus: string | null;
}

export interface CanonicalSnapshot {
  lines: CanonicalLine[];
  subtotalCents: number;
  taxCents: number;
  feeCents: number;
  bufferCents: number;
  holdCents: number;
  fulfillment: "pickup";
  slotId: string;
  slotFeasible: boolean;
  contactVersion: number;
  paymentRef: string;
  purchaseEpoch: number;
  storeStatus: string;
  pickupEnabled: boolean;
  minimumOrderCents: number;
}

export interface StoreShift {
  status: string;
  pickupEnabled: boolean;
  minimumOrderCents: number;
  prepTimeMinutes: number;
  timezone: string;
  hours: unknown;
  stripeOnboardingStatus: string;
}

type LineRow = {
  variantId: string;
  qty: number;
  swapRule: string;
  substituteVariantId: string | null;
  variant: {
    price: number;
    label: string;
    listing: {
      customName: string | null;
      active: boolean;
      confidence: number;
      stockMode: string;
      qty: number | null;
      status: string | null;
      maxPerOrder: number | null;
      masterProduct?: { name: string } | null;
    };
  };
};

export function hashCanonical(snapshot: CanonicalSnapshot): string {
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

export function paymentRef(kind: "new" | "saved", savedPaymentMethodId: string | null): string {
  return kind === "saved" && savedPaymentMethodId ? `saved:${savedPaymentMethodId}` : "new";
}

export function buildCanonical(input: {
  lines: LineRow[];
  contact: Contact;
  contactVersion: number;
  slotId: string;
  paymentRef: string;
  purchaseEpoch: number;
  store: StoreShift;
  now: Date;
  windowMinutes: number;
}): { canonical: CanonicalSnapshot; problems: string[]; names: Array<{ variantId: string; name: string; qty: number; lineTotalCents: number }> } {
  const sorted = [...input.lines].sort((a, b) => a.variantId.localeCompare(b.variantId));
  const lines: CanonicalLine[] = sorted.map((line) => ({
    variantId: line.variantId,
    qty: line.qty,
    price: line.variant.price,
    swapRule: line.swapRule,
    substituteVariantId: line.substituteVariantId,
    maxPerOrder: line.variant.listing.maxPerOrder,
    mayBeUnavailable: mayBeUnavailable(line.variant.listing),
    active: line.variant.listing.active,
    stockMode: line.variant.listing.stockMode,
    stockQty: line.variant.listing.qty,
    stockStatus: line.variant.listing.status,
  }));
  const quote = computeQuote(
    input.store.minimumOrderCents,
    lines.map((line) => ({ price: line.price, qty: line.qty, maxPerOrder: line.maxPerOrder })),
    input.contact,
    "pickup",
  );
  const offer = offerPickupSlots({
    now: input.now,
    timeZone: input.store.timezone,
    hours: input.store.hours,
    prepMinutes: input.store.prepTimeMinutes,
    windowMinutes: input.windowMinutes,
    pickupEnabled: input.store.pickupEnabled && input.store.status === "active",
  });
  const canonical: CanonicalSnapshot = {
    lines,
    subtotalCents: quote.subtotalCents,
    taxCents: quote.taxCents,
    feeCents: quote.deliveryFeeCents + quote.courierFeeCents,
    bufferCents: quote.bufferCents,
    holdCents: quote.holdCents,
    fulfillment: "pickup",
    slotId: input.slotId,
    slotFeasible: slotStillOffered(input.slotId, offer),
    contactVersion: input.contactVersion,
    paymentRef: input.paymentRef,
    purchaseEpoch: input.purchaseEpoch,
    storeStatus: input.store.status,
    pickupEnabled: input.store.pickupEnabled,
    minimumOrderCents: input.store.minimumOrderCents,
  };
  return {
    canonical,
    problems: quote.problems.map((problem) => problem.message),
    names: sorted.map((line) => ({
      variantId: line.variantId,
      name: line.variant.listing.customName || line.variant.listing.masterProduct?.name || line.variant.label,
      qty: line.qty,
      lineTotalCents: line.variant.price * line.qty,
    })),
  };
}

const LINE_INCLUDE = {
  variant: {
    include: {
      listing: { include: { masterProduct: { select: { name: true } } } },
    },
  },
} as const;

type ReadTx = Pick<PrismaClient, "cart" | "cartLine" | "$queryRaw">;

export async function readStoreShift(tx: Pick<PrismaClient, "$queryRaw">, storeId: string): Promise<StoreShift | null> {
  const row = await readStoreCheckoutShift(tx, storeId);
  if (!row) return null;
  return {
    status: row.status,
    pickupEnabled: row.pickupEnabled,
    minimumOrderCents: row.minimumOrderCents,
    prepTimeMinutes: row.prepTimeMinutes,
    timezone: row.timezone,
    hours: row.hours,
    stripeOnboardingStatus: row.stripeOnboardingStatus,
  };
}

export async function readCartLines(tx: Pick<PrismaClient, "cartLine">, cartId: string): Promise<LineRow[]> {
  const rows = await tx.cartLine.findMany({ where: { cartId }, include: LINE_INCLUDE });
  return rows as unknown as LineRow[];
}

export async function liveCanonical(
  tx: ReadTx,
  input: {
    storeId: string;
    cartId: string;
    contact: Contact;
    contactVersion: number;
    slotId: string;
    paymentRef: string;
    now: Date;
    windowMinutes: number;
  },
): Promise<{ canonical: CanonicalSnapshot; names: Array<{ variantId: string; name: string; qty: number; lineTotalCents: number }> } | { missing: "cart" | "store" }> {
  const store = await readStoreShift(tx, input.storeId);
  const cart = await tx.cart.findUnique({ where: { id: input.cartId }, select: { purchaseEpoch: true } });
  const lines = await readCartLines(tx, input.cartId);
  if (!store) return { missing: "store" };
  if (!cart) return { missing: "cart" };
  return buildCanonical({
    lines,
    contact: input.contact,
    contactVersion: input.contactVersion,
    slotId: input.slotId,
    paymentRef: input.paymentRef,
    purchaseEpoch: cart.purchaseEpoch,
    store,
    now: input.now,
    windowMinutes: input.windowMinutes,
  });
}

type DraftReader = {
  assistantCheckoutDraft: {
    findUnique: (args: { where: { conversationId: string } }) => Promise<{
      slotId: string | null;
      contactName: string | null;
      contactEmail: string | null;
      contactPhone: string | null;
      contactVersion: number;
    } | null>;
  };
};

type FrozenAttempt = {
  conversationId: string | null;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  contactVersion: number;
  snapshot: unknown;
  windowMinutes: number;
  paymentKind: string;
  savedPaymentMethodId: string | null;
};

function storedSlot(snapshot: unknown): string {
  if (!snapshot || typeof snapshot !== "object" || !("slotId" in snapshot)) return "";
  const slotId = (snapshot as { slotId?: unknown }).slotId;
  return typeof slotId === "string" ? slotId : "";
}

/** Consent copied onto the attempt when it was drawn. The live draft is not consent. */
export function frozenConsent(attempt: FrozenAttempt): {
  contact: Contact;
  contactVersion: number;
  slotId: string;
  paymentRef: string;
  windowMinutes: number;
} {
  return {
    contact: {
      name: attempt.contactName ?? "",
      email: attempt.contactEmail ?? "",
      phone: attempt.contactPhone ?? "",
    },
    contactVersion: attempt.contactVersion,
    slotId: storedSlot(attempt.snapshot),
    paymentRef: paymentRef(attempt.paymentKind === "saved" ? "saved" : "new", attempt.savedPaymentMethodId),
    windowMinutes: attempt.windowMinutes,
  };
}

/** Live draft slot and contact version, hashed only to see that the drawn card is still current. */
export async function stalenessInputs(
  tx: DraftReader,
  attempt: FrozenAttempt,
): Promise<{ contact: Contact; contactVersion: number; slotId: string; paymentRef: string; windowMinutes: number }> {
  const frozen = frozenConsent(attempt);
  const draft = attempt.conversationId
    ? await tx.assistantCheckoutDraft.findUnique({ where: { conversationId: attempt.conversationId } })
    : null;
  if (!draft) return frozen;
  return {
    ...frozen,
    contactVersion: draft.contactVersion,
    slotId: draft.slotId ?? "",
  };
}

/** @deprecated Use frozenConsent. Kept so older callers still compile during the ownership fix. */
export async function consentedCheckout(
  tx: DraftReader,
  attempt: FrozenAttempt,
): Promise<{ contact: Contact; contactVersion: number; slotId: string; paymentRef: string; windowMinutes: number }> {
  return stalenessInputs(tx, attempt);
}
