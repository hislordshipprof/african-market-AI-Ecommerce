"use server";

import { headers } from "next/headers";
import { z } from "zod";
import { auth } from "../auth";
import { parseInput } from "../security/parse-input";
import {
  ADDRESS_MESSAGES,
  ADDRESS_NOT_FOUND,
  SIGN_IN_MESSAGE,
  validateAddress,
  type AddressValidation,
} from "./address-validation";
import {
  addAddress,
  editAddress,
  listAddresses,
  removeAddress,
  saveAccountPhone,
  setDefaultAddress,
} from "./address-book";
import { CARD_NOT_FOUND, CARDS_UNAVAILABLE } from "./consent";
import { listAccountCards, removeAccountCard, type AccountCard } from "./saved-cards";
import { loadCheckoutPrefill } from "./checkout-profile";

async function requireUserId(): Promise<string> {
  const session = await auth.api.getSession({
    headers: await headers(),
    query: { disableCookieCache: true },
  });
  const userId = session?.user?.id;
  if (!userId) throw new Error(SIGN_IN_MESSAGE);
  return userId;
}

function failed(error: unknown): { ok: false; error: string } {
  return { ok: false, error: error instanceof Error ? error.message : "Something went wrong. Please try again." };
}

const addressSchema = z.strictObject({
  label: z.string({ error: ADDRESS_MESSAGES.label }),
  line1: z.string({ error: ADDRESS_MESSAGES.line1 }),
  line2: z.string({ error: ADDRESS_MESSAGES.line2 }).nullable().optional(),
  city: z.string({ error: ADDRESS_MESSAGES.city }),
  state: z.string({ error: ADDRESS_MESSAGES.state }),
  zip: z.string({ error: ADDRESS_MESSAGES.zip }),
  notes: z.string({ error: ADDRESS_MESSAGES.notes }).nullable().optional(),
}, { error: ADDRESS_MESSAGES.invalid });

function readAddress(input: unknown): AddressValidation {
  const parsed = parseInput(addressSchema, input);
  if (!parsed.ok) return { ok: false, error: parsed.issues[0] ?? ADDRESS_MESSAGES.invalid };
  return validateAddress(parsed.data);
}

function readId(value: unknown): { ok: true; id: string } | { ok: false; error: string } {
  const parsed = parseInput(z.string().min(1).max(200), value);
  if (!parsed.ok) return { ok: false, error: ADDRESS_NOT_FOUND };
  return { ok: true, id: parsed.data };
}

export async function savePhoneAction(phone: string): Promise<{ ok: true; phone: string | null } | { ok: false; error: string }> {
  try {
    const userId = await requireUserId();
    const parsed = parseInput(z.union([z.string().max(80), z.null()]), phone);
    if (!parsed.ok) return { ok: false, error: "Enter a valid phone number." };
    const saved = await saveAccountPhone(userId, parsed.data);
    return { ok: true, phone: saved };
  } catch (error) {
    return failed(error);
  }
}

export async function addAddressAction(input: unknown) {
  try {
    const userId = await requireUserId();
    const addressInput = readAddress(input);
    if (!addressInput.ok) return addressInput;
    const address = await addAddress(userId, addressInput.value);
    return { ok: true as const, address, addresses: await listAddresses(userId) };
  } catch (error) {
    return failed(error);
  }
}

export async function editAddressAction(addressId: string, input: unknown) {
  try {
    const userId = await requireUserId();
    const id = readId(addressId);
    const addressInput = readAddress(input);
    if (!id.ok) return id;
    if (!addressInput.ok) return addressInput;
    await editAddress(userId, id.id, addressInput.value);
    return { ok: true as const, addresses: await listAddresses(userId) };
  } catch (error) {
    return failed(error);
  }
}

export async function removeAddressAction(addressId: string) {
  try {
    const userId = await requireUserId();
    const id = readId(addressId);
    if (!id.ok) return id;
    await removeAddress(userId, id.id);
    return { ok: true as const, addresses: await listAddresses(userId) };
  } catch (error) {
    return failed(error);
  }
}

export async function setDefaultAddressAction(addressId: string) {
  try {
    const userId = await requireUserId();
    const id = readId(addressId);
    if (!id.ok) return id;
    await setDefaultAddress(userId, id.id);
    return { ok: true as const, addresses: await listAddresses(userId) };
  } catch (error) {
    return failed(error);
  }
}

// Only these three fields are safe to log: a provider's message can echo the API key.
function logCardFailure(event: string, error: unknown): void {
  const source = error instanceof Error && error.cause !== undefined ? error.cause : error;
  const { type, code, statusCode } = (source ?? {}) as { type?: unknown; code?: unknown; statusCode?: unknown };
  console.error(JSON.stringify({ event, type, code, statusCode }));
}

function publicCardError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message === SIGN_IN_MESSAGE || message === CARD_NOT_FOUND) return message;
  logCardFailure("saved_card_removal_failed", error);
  return CARDS_UNAVAILABLE;
}

async function cardsAfterRemoval(userId: string) {
  try {
    return { ok: true as const, ...(await listAccountCards(userId)) };
  } catch (error) {
    logCardFailure("saved_card_list_refresh_failed", error);
    return { ok: true as const, unavailable: true, cards: [] as AccountCard[] };
  }
}

export async function removeCardAction(paymentMethodId: string) {
  try {
    const userId = await requireUserId();
    // Stripe ids are letters, digits and underscores. Its edge answers other ids with a
    // 400 that says nothing about a card, which would read as an outage and fill the log.
    const id = parseInput(z.string().min(1).max(200).regex(/^[A-Za-z0-9_]+$/), paymentMethodId);
    if (!id.ok) return { ok: false as const, error: CARD_NOT_FOUND };
    await removeAccountCard(userId, id.data);
    return await cardsAfterRemoval(userId);
  } catch (error) {
    return { ok: false as const, error: publicCardError(error) };
  }
}

export async function accountBookAction() {
  try {
    const userId = await requireUserId();
    const [prefill, cards] = await Promise.all([
      loadCheckoutPrefill(userId),
      listAccountCards(userId),
    ]);
    return {
      ok: true as const,
      phone: prefill.contact.phone,
      addresses: await listAddresses(userId),
      cards: cards.cards,
      cardsUnavailable: cards.unavailable,
    };
  } catch (error) {
    return failed(error);
  }
}
