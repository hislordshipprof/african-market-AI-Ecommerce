"use server";

import { headers } from "next/headers";
import { z } from "zod";
import { auth } from "../auth";
import { parseInput } from "../security/parse-input";
import { ADDRESS_NOT_FOUND, SIGN_IN_MESSAGE, validateAddress, type AddressInput } from "./address-validation";
import {
  addAddress,
  editAddress,
  listAddresses,
  removeAddress,
  saveAccountPhone,
  setDefaultAddress,
} from "./address-book";
import { CARD_NOT_FOUND } from "./consent";
import { listAccountCards, removeAccountCard } from "./saved-cards";
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

function readAddress(input: unknown): { ok: true; value: AddressInput } | { ok: false; error: string } {
  const checked = validateAddress(input);
  const parsed = parseInput(z.custom<AddressInput>((value) => validateAddress(value).ok), input);
  if (!checked.ok || !parsed.ok) {
    return { ok: false, error: checked.ok ? "Enter an address label of 1 to 40 characters." : checked.error };
  }
  return { ok: true, value: checked.value };
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

export async function removeCardAction(paymentMethodId: string) {
  try {
    const userId = await requireUserId();
    const id = parseInput(z.string().min(1).max(200), paymentMethodId);
    if (!id.ok) return { ok: false as const, error: CARD_NOT_FOUND };
    await removeAccountCard(userId, id.data);
    const cards = await listAccountCards(userId);
    return { ok: true as const, ...cards };
  } catch (error) {
    return failed(error);
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
