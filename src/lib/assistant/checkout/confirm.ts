import { randomBytes } from "node:crypto";
import {
  AssistantCheckoutInProgressError,
  BasketChangedError,
  createPaymentIntent,
  placeOrder,
  SavedCardUnavailableError,
} from "../../checkout/service";
import { lockCart, lockConversationRow, lockStoreRow, storeScoped, storeScopedTransaction } from "../../db";
import { assistantChatEnabled } from "../contract";
import { newCheckoutAllowed } from "./gates";
import { prepareCheckout, tokenHash, type PrepareContext, type PrepareResult } from "./prepare";
import { hashCanonical, liveCanonical, paymentRef } from "./snapshot";

export interface ConfirmInput {
  storeId: string;
  cartId: string;
  actorUserId: string | null;
  token: string;
  phase: "reserve" | "complete";
  now?: Date;
  loadAccountContact?: PrepareContext["loadAccountContact"];
  loadMaskedFacts?: PrepareContext["loadMaskedFacts"];
}

export type ConfirmResult =
  | { ok: true; kind: "client_secret"; clientSecret: string; paymentIntentId: string; amount: number }
  | { ok: true; kind: "saved"; paymentIntentId: string; amount: number }
  | { ok: true; kind: "order"; orderId: string }
  | { ok: false; code: string; message: string; card?: PrepareResult };

function deny(): ConfirmResult {
  return { ok: false, code: "not_found", message: "That checkout is not available." };
}

export async function mintCheckoutToken(input: {
  storeId: string;
  cartId: string;
  actorUserId: string | null;
  conversationId: string;
}): Promise<{ token: string; card: PrepareResult } | null> {
  const attempt = await storeScoped(input.storeId).assistantCheckoutAttempt.findFirst({
    where: {
      conversationId: input.conversationId,
      cartId: input.cartId,
      status: { in: ["open", "reserved", "awaiting_payment", "placed"] },
    },
    orderBy: { createdAt: "desc" },
  });
  if (!attempt) return null;
  const cart = await storeScoped(input.storeId).cart.findUnique({ where: { id: input.cartId } });
  if (!cart || !owns(cart.userId, attempt.actorUserId, attempt.paymentKind, input.actorUserId)) return null;
  const token = randomBytes(16).toString("hex");
  await storeScoped(input.storeId).assistantCheckoutToken.create({
    data: { tokenHash: tokenHash(token), storeId: input.storeId, attemptId: attempt.id },
  });
  const snapshot = attempt.snapshot as { holdCents?: number; lines?: PrepareResult["lines"]; cancelMinutes?: number; card?: PrepareResult["card"] };
  return {
    token,
    card: {
      ok: true,
      kind: attempt.status === "placed" ? "placed" : attempt.status === "open" ? "confirm" : "recovery_required",
      holdCents: snapshot.holdCents,
      lines: snapshot.lines,
      cancelMinutes: snapshot.cancelMinutes,
      card: snapshot.card ?? null,
      paymentKind: attempt.paymentKind === "saved" ? "saved" : "new",
      message: attempt.orderId ? "Order placed." : "Review and tap Place order.",
    },
  };
}

function owns(cartUserId: string | null, attemptUserId: string | null, paymentKind: string, actorUserId: string | null): boolean {
  if (cartUserId && cartUserId !== actorUserId) return false;
  if (!cartUserId && actorUserId) return false;
  if (paymentKind === "saved" && attemptUserId !== actorUserId) return false;
  if (attemptUserId && attemptUserId !== actorUserId) return false;
  return true;
}

export async function confirmCheckout(input: ConfirmInput): Promise<ConfirmResult> {
  const now = input.now ?? new Date();
  const loaded = await storeScopedTransaction(input.storeId, async (tx) => {
    await lockStoreRow(tx, input.storeId);
    await lockCart(tx, input.cartId);
    const token = await tx.assistantCheckoutToken.findUnique({ where: { tokenHash: tokenHash(input.token) } });
    if (!token) return { kind: "missing" as const };
    const attempt = await tx.assistantCheckoutAttempt.findUnique({ where: { id: token.attemptId } });
    const cart = await tx.cart.findUnique({ where: { id: input.cartId } });
    if (!attempt || !cart || attempt.cartId !== cart.id) return { kind: "missing" as const };
    if (attempt.conversationId) await lockConversationRow(tx, attempt.conversationId);
    const freshAttempt = await tx.assistantCheckoutAttempt.findUnique({ where: { id: attempt.id } });
    const freshCart = await tx.cart.findUnique({ where: { id: cart.id } });
    if (!freshAttempt || !freshCart || !owns(freshCart.userId, freshAttempt.actorUserId, freshAttempt.paymentKind, input.actorUserId)) {
      return { kind: "missing" as const };
    }
    if (freshAttempt.orderId) return { kind: "order" as const, orderId: freshAttempt.orderId };
    return { kind: "attempt" as const, attempt: freshAttempt };
  });

  if (loaded.kind === "missing") return deny();
  if (loaded.kind === "order") return { ok: true, kind: "order", orderId: loaded.orderId };

  const attempt = loaded.attempt;
  if (input.phase === "complete") return complete(input, attempt.id);
  if (!assistantChatEnabled() || !newCheckoutAllowed().ok) {
    if (attempt.status === "reserved" || attempt.status === "awaiting_payment") {
      return complete(input, attempt.id);
    }
    return { ok: false, code: "not_found", message: "Checkout is unavailable right now." };
  }
  return reserve(input, attempt.id, now);
}

async function reserve(input: ConfirmInput, attemptId: string, now: Date): Promise<ConfirmResult> {
  const decision = await storeScopedTransaction(input.storeId, async (tx) => {
    await lockStoreRow(tx, input.storeId);
    await lockCart(tx, input.cartId);
    const attempt = await tx.assistantCheckoutAttempt.findUnique({ where: { id: attemptId } });
    if (!attempt || attempt.status === "superseded") return { action: "stale" as const, conversationId: attempt?.conversationId ?? null };
    if (attempt.orderId) return { action: "order" as const, orderId: attempt.orderId };
    if (attempt.status === "awaiting_payment" && attempt.paymentIntentId) {
      return { action: "held" as const, attempt };
    }
    const stored = attempt.snapshot as { slotId?: string; canonical?: { contactVersion?: number } };
    const live = await liveCanonical(tx, {
      storeId: input.storeId,
      cartId: input.cartId,
      contact: { name: attempt.contactName ?? "", email: attempt.contactEmail ?? "", phone: attempt.contactPhone ?? "" },
      contactVersion: attempt.contactVersion,
      slotId: stored.slotId ?? "",
      paymentRef: paymentRef(attempt.paymentKind === "saved" ? "saved" : "new", attempt.savedPaymentMethodId),
      now,
      windowMinutes: attempt.windowMinutes,
    });
    const expired = attempt.expiresAt.getTime() <= now.getTime();
    const stale = "missing" in live || hashCanonical(live.canonical) !== attempt.snapshotHash || !live.canonical.slotFeasible;
    if ((expired || stale) && !attempt.paymentIntentId && attempt.status !== "reserved") {
      await tx.assistantCheckoutAttempt.update({ where: { id: attempt.id }, data: { status: "superseded" } });
      return { action: "stale" as const, conversationId: attempt.conversationId };
    }
    if (attempt.status === "reserved") return { action: "create" as const, attempt };
    await tx.assistantCheckoutAttempt.update({
      where: { id: attempt.id },
      data: { status: "reserved" },
    });
    return { action: "create" as const, attempt: { ...attempt, status: "reserved" } };
  });

  if (decision.action === "order") return { ok: true, kind: "order", orderId: decision.orderId };
  if (decision.action === "stale") {
    const card = decision.conversationId
      ? await prepareCheckout({ ...context(input, now), conversationId: decision.conversationId })
      : undefined;
    return { ok: false, code: "stale", message: "The total changed. Review the new card.", card };
  }
  if (decision.action === "held") return complete(input, decision.attempt.id);

  try {
    const created = await createWithRetry(input, decision.attempt);
    await storeScopedTransaction(input.storeId, async (tx) => {
      await lockStoreRow(tx, input.storeId);
      const current = await tx.assistantCheckoutAttempt.findUnique({ where: { id: decision.attempt.id } });
      if (!current || current.paymentIntentId || current.status === "superseded") return;
      await tx.assistantCheckoutAttempt.update({
        where: { id: current.id },
        data: { paymentIntentId: created.paymentIntentId, status: "awaiting_payment" },
      });
    });
    if (decision.attempt.paymentKind === "saved") {
      return { ok: true, kind: "saved", paymentIntentId: created.paymentIntentId, amount: decision.attempt.reservedAmountCents };
    }
    return { ok: true, kind: "client_secret", clientSecret: created.clientSecret, paymentIntentId: created.paymentIntentId, amount: decision.attempt.reservedAmountCents };
  } catch (error) {
    if (error instanceof SavedCardUnavailableError) {
      await storeScoped(input.storeId).assistantCheckoutAttempt.update({
        where: { id: decision.attempt.id },
        data: { status: "open", paymentKind: "new", savedPaymentMethodId: null },
      });
      return { ok: false, code: "saved_card_unavailable", message: "That saved card is not available. Enter a card on the new form." };
    }
    if (error instanceof AssistantCheckoutInProgressError) {
      return { ok: false, code: "in_progress", message: "A payment is already in progress for this basket." };
    }
    return { ok: false, code: "payment_unavailable", message: "The payment service is unavailable. You have not been charged." };
  }
}

async function createWithRetry(input: ConfirmInput, attempt: { id: string; idempotencyKey: string; reservedAmountCents: number; paymentKind: string; savedPaymentMethodId: string | null; actorUserId: string | null }) {
  let last: unknown;
  for (let tryNo = 0; tryNo < 3; tryNo += 1) {
    try {
      return await createPaymentIntent(input.storeId, input.cartId, attempt.reservedAmountCents, {
        actorUserId: attempt.paymentKind === "saved" ? attempt.actorUserId : null,
        savedCardId: attempt.paymentKind === "saved" ? attempt.savedPaymentMethodId : null,
        assistantAttemptId: attempt.id,
        idempotencyKey: attempt.idempotencyKey,
      });
    } catch (error) {
      last = error;
      const message = error instanceof Error ? error.message : "";
      if (!message.includes("idempotency_key_in_use") && !message.includes("idempotency")) throw error;
    }
  }
  throw last;
}

async function complete(input: ConfirmInput, attemptId: string): Promise<ConfirmResult> {
  const attempt = await storeScoped(input.storeId).assistantCheckoutAttempt.findUnique({ where: { id: attemptId } });
  if (!attempt?.paymentIntentId) return { ok: false, code: "not_charged", message: "You have not been charged yet. Try again." };
  if (attempt.orderId) return { ok: true, kind: "order", orderId: attempt.orderId };
  const minimum = await readMinimum(input.storeId);
  const slotId = snapshotSlot(attempt.snapshot);
  try {
    const placed = await placeOrder(
      input.storeId,
      minimum,
      input.cartId,
      { name: attempt.contactName ?? "", email: attempt.contactEmail ?? "", phone: attempt.contactPhone ?? "" },
      "pickup",
      null,
      slotId,
      attempt.paymentIntentId,
      input.actorUserId,
      attempt.id,
    );
    return { ok: true, kind: "order", orderId: placed.token };
  } catch (error) {
    if (error instanceof BasketChangedError) {
      const card = attempt.conversationId
        ? await prepareCheckout({ ...context(input, input.now ?? new Date()), conversationId: attempt.conversationId })
        : undefined;
      return { ok: false, code: "basket_changed", message: "The total changed and the hold was released. Review the new card.", card };
    }
    return { ok: false, code: "not_charged", message: "You have not been charged yet. Try again." };
  }
}

async function readMinimum(storeId: string): Promise<number> {
  const rows = await storeScopedTransaction(storeId, (tx) => tx.$queryRaw<Array<{ minimum_order_cents: number }>>`
    SELECT minimum_order_cents FROM stores WHERE id = ${storeId}
  `);
  return rows[0]?.minimum_order_cents ?? 0;
}

function snapshotSlot(snapshot: unknown): string | null {
  if (!snapshot || typeof snapshot !== "object" || !("slotId" in snapshot)) return null;
  const slotId = (snapshot as { slotId?: unknown }).slotId;
  return typeof slotId === "string" ? slotId : null;
}

function context(input: ConfirmInput, now: Date): PrepareContext {
  return {
    storeId: input.storeId,
    cartId: input.cartId,
    conversationId: "",
    actorUserId: input.actorUserId,
    now,
    loadAccountContact: input.loadAccountContact,
    loadMaskedFacts: input.loadMaskedFacts,
  };
}
