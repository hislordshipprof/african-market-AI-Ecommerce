import { createHash, randomUUID } from "node:crypto";
import type { Contact } from "../../customer-flow/contracts";
import { lockCart, lockStoreRow, storeScoped, storeScopedTransaction } from "../../db";
import { newCheckoutAllowed, STRIPE_USD_MAX_CENTS, STRIPE_USD_MIN_CENTS } from "./gates";
import { offerPickupSlots } from "./slots";
import { buildCanonical, hashCanonical, paymentRef, readCartLines, readStoreShift, type CanonicalSnapshot } from "./snapshot";
import { projectCheckoutSecrets } from "./safe-output";

export interface AccountContact {
  name: string;
  email: string;
  phone: string;
}

export interface MaskedFacts {
  contactOnFile: boolean;
  card: { brand: string; last4: string } | null;
  addressOnFile: boolean;
  savedPaymentMethodId: string | null;
}

const EMPTY_FACTS: MaskedFacts = {
  contactOnFile: false,
  card: null,
  addressOnFile: false,
  savedPaymentMethodId: null,
};

export interface PrepareContext {
  storeId: string;
  cartId: string;
  conversationId: string;
  actorUserId: string | null;
  now?: Date;
  loadAccountContact?: (actorUserId: string) => Promise<AccountContact | null>;
  loadMaskedFacts?: (actorUserId: string) => Promise<MaskedFacts>;
}

export type PrepareResult = {
  ok: boolean;
  kind: string;
  code?: string;
  message?: string;
  holdCents?: number;
  subtotalCents?: number;
  taxCents?: number;
  feeCents?: number;
  bufferCents?: number;
  cancelMinutes?: number;
  slotLabel?: string | null;
  lines?: Array<{ name: string; qty: number; lineTotalCents: number }>;
  card?: { brand: string; last4: string } | null;
  contactOnFile?: boolean;
  addressOnFile?: boolean;
  paymentKind?: "new" | "saved";
  slots?: Array<{ id: string; label: string }>;
};

function contactReady(contact: AccountContact | null | undefined): contact is AccountContact {
  return Boolean(contact && contact.name.trim() && contact.email.trim() && contact.phone.trim());
}

async function factsFor(ctx: PrepareContext): Promise<MaskedFacts> {
  if (!ctx.actorUserId || !ctx.loadMaskedFacts) return EMPTY_FACTS;
  try {
    return await ctx.loadMaskedFacts(ctx.actorUserId);
  } catch {
    return { ...EMPTY_FACTS, card: null };
  }
}

export async function getFulfillmentOptions(ctx: PrepareContext): Promise<PrepareResult> {
  const now = ctx.now ?? new Date();
  const store = await storeScopedTransaction(ctx.storeId, (tx) => readStoreShift(tx, ctx.storeId));
  if (!store) return { ok: false, kind: "missing", code: "store", message: "This store is not available." };
  if (!store.pickupEnabled) {
    return { ok: true, kind: "slots", code: "pickup_off", message: "This store is not offering pickup right now.", lines: [] };
  }
  const window = newCheckoutAllowed();
  const offer = offerPickupSlots({
    now,
    timeZone: store.timezone,
    hours: store.hours,
    prepMinutes: store.prepTimeMinutes,
    windowMinutes: window.ok ? window.minutes : 10,
    pickupEnabled: store.pickupEnabled && store.status === "active",
  });
  if (offer.reason === "hours_unavailable") {
    return { ok: true, kind: "slots", code: "hours_unavailable", message: "Pickup times are not available for this store today." };
  }
  if (offer.slots.length === 0) {
    return { ok: true, kind: "slots", code: "closed", message: "This store is not offering pickup for the rest of today." };
  }
  return {
    ok: true,
    kind: "slots",
    message: "Pickup times for today.",
    slots: offer.slots.map((slot) => ({ id: slot.id, label: slot.label })),
  };
}

export async function setFulfillment(ctx: PrepareContext, slotId: string): Promise<PrepareResult> {
  const now = ctx.now ?? new Date();
  return storeScopedTransaction(ctx.storeId, async (tx) => {
    const conversation = await tx.aiConversation.findUnique({ where: { id: ctx.conversationId } });
    if (!conversation || conversation.cartId !== ctx.cartId) {
      return { ok: false, kind: "missing", code: "conversation", message: "That conversation is not available." };
    }
    const store = await readStoreShift(tx, ctx.storeId);
    if (!store?.pickupEnabled) {
      return { ok: false, kind: "missing", code: "pickup_off", message: "This store is not offering pickup right now." };
    }
    const window = newCheckoutAllowed();
    const offer = offerPickupSlots({
      now,
      timeZone: store.timezone,
      hours: store.hours,
      prepMinutes: store.prepTimeMinutes,
      windowMinutes: window.ok ? window.minutes : 10,
      pickupEnabled: store.status === "active",
    });
    if (!offer.slots.some((slot) => slot.id === slotId)) {
      return { ok: false, kind: "missing", code: "slot", message: "That pickup time is no longer available." };
    }
    await tx.assistantCheckoutDraft.upsert({
      where: { conversationId: ctx.conversationId },
      create: {
        storeId: ctx.storeId,
        conversationId: ctx.conversationId,
        fulfillment: "pickup",
        slotId,
      },
      update: { fulfillment: "pickup", slotId },
    });
    return { ok: true, kind: "fulfillment", message: "Pickup time saved.", slotLabel: offer.slots.find((slot) => slot.id === slotId)?.label ?? null };
  });
}

export async function saveGuestContact(ctx: PrepareContext, contact: AccountContact): Promise<{ ok: true } | { ok: false; code: string }> {
  const conversation = await storeScoped(ctx.storeId).aiConversation.findUnique({ where: { id: ctx.conversationId } });
  if (!conversation || conversation.cartId !== ctx.cartId) return { ok: false, code: "not_found" };
  await storeScopedTransaction(ctx.storeId, async (tx) => {
    const existing = await tx.assistantCheckoutDraft.findUnique({ where: { conversationId: ctx.conversationId } });
    await tx.assistantCheckoutDraft.upsert({
      where: { conversationId: ctx.conversationId },
      create: {
        storeId: ctx.storeId,
        conversationId: ctx.conversationId,
        contactName: contact.name.trim(),
        contactEmail: contact.email.trim(),
        contactPhone: contact.phone.trim(),
        contactVersion: 1,
      },
      update: {
        contactName: contact.name.trim(),
        contactEmail: contact.email.trim(),
        contactPhone: contact.phone.trim(),
        contactVersion: (existing?.contactVersion ?? 0) + 1,
      },
    });
  });
  return { ok: true };
}

export async function checkoutProfile(ctx: PrepareContext): Promise<PrepareResult> {
  const facts = await factsFor(ctx);
  const draft = await storeScoped(ctx.storeId).assistantCheckoutDraft.findUnique({ where: { conversationId: ctx.conversationId } });
  const draftContact = contactReady(draft ? { name: draft.contactName ?? "", email: draft.contactEmail ?? "", phone: draft.contactPhone ?? "" } : null);
  return projectCheckoutSecrets({
    ok: true,
    kind: "profile",
    contactOnFile: draftContact || facts.contactOnFile,
    card: facts.card,
    addressOnFile: facts.addressOnFile,
    message: draftContact || facts.contactOnFile ? "Contact is on file." : "Contact is missing.",
  }) as PrepareResult;
}

function missing(code: string, message: string): PrepareResult {
  return { ok: false, kind: "missing", code, message };
}

export async function prepareCheckout(ctx: PrepareContext): Promise<PrepareResult> {
  const now = ctx.now ?? new Date();
  const facts = await factsFor(ctx);
  const inFlight = await storeScoped(ctx.storeId).assistantCheckoutAttempt.findFirst({
    where: {
      conversationId: ctx.conversationId,
      cartId: ctx.cartId,
      status: { in: ["reserved", "awaiting_payment"] },
    },
    orderBy: { createdAt: "desc" },
  });
  if (inFlight) {
    return { ok: true, kind: "recovery_required", message: "A payment is already in progress. Use the card to finish or try again." };
  }
  const gate = newCheckoutAllowed();
  if (!gate.ok) return missing("checkout_unavailable", "Checkout is unavailable right now.");

  return storeScopedTransaction(ctx.storeId, async (tx) => {
    await lockStoreRow(tx, ctx.storeId);
    const conversation = await tx.aiConversation.findUnique({ where: { id: ctx.conversationId } });
    if (!conversation || conversation.cartId !== ctx.cartId) return missing("conversation", "That conversation is not available.");
    await lockCart(tx, ctx.cartId);
    const cart = await tx.cart.findUnique({ where: { id: ctx.cartId } });
    if (!cart) return missing("cart", "Your basket is empty.");
    if (cart.userId && cart.userId !== ctx.actorUserId) return missing("cart", "Your basket is empty.");
    if (!cart.userId && ctx.actorUserId) return missing("cart", "Your basket is empty.");
    const draft = await tx.assistantCheckoutDraft.findUnique({ where: { conversationId: ctx.conversationId } });
    let contact: Contact | null = draft && contactReady({
      name: draft.contactName ?? "",
      email: draft.contactEmail ?? "",
      phone: draft.contactPhone ?? "",
    })
      ? { name: draft.contactName!.trim(), email: draft.contactEmail!.trim(), phone: draft.contactPhone!.trim() }
      : null;
    let contactVersion = draft?.contactVersion ?? 0;
    if (!contact && ctx.actorUserId && ctx.loadAccountContact) {
      const account = await ctx.loadAccountContact(ctx.actorUserId);
      if (contactReady(account)) {
        contact = { name: account.name.trim(), email: account.email.trim(), phone: account.phone.trim() };
        contactVersion += 1;
        await tx.assistantCheckoutDraft.upsert({
          where: { conversationId: ctx.conversationId },
          create: {
            storeId: ctx.storeId,
            conversationId: ctx.conversationId,
            contactName: contact.name,
            contactEmail: contact.email,
            contactPhone: contact.phone,
            contactVersion,
            slotId: draft?.slotId,
          },
          update: {
            contactName: contact.name,
            contactEmail: contact.email,
            contactPhone: contact.phone,
            contactVersion,
          },
        });
      }
    }
    if (!draft?.slotId) return missing("slot", "Choose a pickup time first.");
    if (!contact) return missing("contact", "Add a name, email, and phone to continue.");
    const lines = await readCartLines(tx, ctx.cartId);
    if (lines.length === 0) return missing("cart", "Your basket is empty.");
    const store = await readStoreShift(tx, ctx.storeId);
    if (!store || store.status !== "active" || store.stripeOnboardingStatus !== "complete") {
      return missing("checkout_unavailable", "Checkout is unavailable right now.");
    }
    const kind = facts.savedPaymentMethodId ? "saved" as const : "new" as const;
    const built = buildCanonical({
      lines,
      contact,
      contactVersion,
      slotId: draft.slotId,
      paymentRef: paymentRef(kind, facts.savedPaymentMethodId),
      purchaseEpoch: cart.purchaseEpoch,
      store,
      now,
      windowMinutes: gate.minutes,
    });
    if (!built.canonical.slotFeasible) return missing("slot", "That pickup time is no longer available.");
    if (built.canonical.lines.some((line) => !line.active)) return missing("unavailable", "An item in your basket is no longer available.");
    if (built.canonical.holdCents < STRIPE_USD_MIN_CENTS) return missing("minimum", "Order total is too low.");
    if (built.canonical.holdCents > STRIPE_USD_MAX_CENTS) return missing("maximum", "This order is too large to place online.");
    const quoteProblems = built.canonical.holdCents <= 0;
    if (quoteProblems) return missing("cart", "Your basket is empty.");
    const subtotal = built.canonical.subtotalCents;
    if (subtotal < store.minimumOrderCents) return missing("minimum", "This order is below the store minimum.");

    await tx.assistantCheckoutAttempt.updateMany({
      where: { conversationId: ctx.conversationId, status: "open" },
      data: { status: "superseded" },
    });
    const id = randomUUID();
    const snapshot = cardSnapshot(built.canonical, built.names, draft.slotId, facts.card, gate.minutes);
    await tx.assistantCheckoutAttempt.create({
      data: {
        id,
        storeId: ctx.storeId,
        conversationId: ctx.conversationId,
        cartId: ctx.cartId,
        actorUserId: ctx.actorUserId,
        status: "open",
        snapshotHash: hashCanonical(built.canonical),
        snapshot: JSON.parse(JSON.stringify(snapshot)) as object,
        paymentKind: kind,
        savedPaymentMethodId: kind === "saved" ? facts.savedPaymentMethodId : null,
        idempotencyKey: `assistant-pi:${id}`,
        reservedAmountCents: built.canonical.holdCents,
        windowMinutes: gate.minutes,
        contactName: contact.name,
        contactEmail: contact.email,
        contactPhone: contact.phone,
        contactVersion,
        expiresAt: new Date(now.getTime() + 15 * 60_000),
      },
    });
    return {
      ok: true,
      kind: "confirm",
      holdCents: built.canonical.holdCents,
      subtotalCents: built.canonical.subtotalCents,
      taxCents: built.canonical.taxCents,
      feeCents: built.canonical.feeCents,
      bufferCents: built.canonical.bufferCents,
      cancelMinutes: gate.minutes,
      slotLabel: slotLabel(store, draft.slotId, now, gate.minutes),
      lines: built.names.map((line) => ({ name: line.name, qty: line.qty, lineTotalCents: line.lineTotalCents })),
      card: facts.card,
      paymentKind: kind,
      message: "Review the card and tap Place order. The helper cannot place it.",
    };
  });
}

function cardSnapshot(
  canonical: CanonicalSnapshot,
  names: Array<{ name: string; qty: number; lineTotalCents: number }>,
  slotId: string,
  card: { brand: string; last4: string } | null,
  cancelMinutes: number,
) {
  return {
    canonical,
    lines: names,
    slotId,
    card,
    cancelMinutes,
    holdCents: canonical.holdCents,
    subtotalCents: canonical.subtotalCents,
    taxCents: canonical.taxCents,
    feeCents: canonical.feeCents,
    bufferCents: canonical.bufferCents,
  };
}

function slotLabel(store: { timezone: string; hours: unknown; prepTimeMinutes: number; pickupEnabled: boolean; status: string }, slotId: string, now: Date, windowMinutes: number): string | null {
  const offer = offerPickupSlots({
    now,
    timeZone: store.timezone,
    hours: store.hours,
    prepMinutes: store.prepTimeMinutes,
    windowMinutes,
    pickupEnabled: store.pickupEnabled && store.status === "active",
  });
  return offer.slots.find((slot) => slot.id === slotId)?.label ?? slotId;
}

export function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
