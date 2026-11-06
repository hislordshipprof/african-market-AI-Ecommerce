import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
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
  hours: Prisma.JsonValue;
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
}): { canonical: CanonicalSnapshot; names: Array<{ variantId: string; name: string; qty: number; lineTotalCents: number }> } {
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
  const rows = await tx.$queryRaw<Array<{
    status: string;
    pickup_enabled: boolean;
    minimum_order_cents: number;
    prep_time_minutes: number;
    timezone: string;
    hours: Prisma.JsonValue;
    stripe_onboarding_status: string;
  }>>`
    SELECT status, pickup_enabled, minimum_order_cents, prep_time_minutes, timezone, hours, stripe_onboarding_status
    FROM stores WHERE id = ${storeId}
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    status: row.status,
    pickupEnabled: row.pickup_enabled,
    minimumOrderCents: row.minimum_order_cents,
    prepTimeMinutes: row.prep_time_minutes,
    timezone: row.timezone,
    hours: row.hours,
    stripeOnboardingStatus: row.stripe_onboarding_status,
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
