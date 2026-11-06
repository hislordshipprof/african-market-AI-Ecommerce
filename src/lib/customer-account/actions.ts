"use server";

import { headers } from "next/headers";
import { auth } from "../auth";
import { SIGN_IN_MESSAGE } from "./address-validation";
import {
  addAddress,
  editAddress,
  listAddresses,
  removeAddress,
  saveAccountPhone,
  setDefaultAddress,
} from "./address-book";
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

export async function savePhoneAction(phone: string): Promise<{ ok: true; phone: string | null } | { ok: false; error: string }> {
  try {
    const userId = await requireUserId();
    const saved = await saveAccountPhone(userId, phone);
    return { ok: true, phone: saved };
  } catch (error) {
    return failed(error);
  }
}

export async function addAddressAction(input: unknown) {
  try {
    const userId = await requireUserId();
    const address = await addAddress(userId, input);
    return { ok: true as const, address, addresses: await listAddresses(userId) };
  } catch (error) {
    return failed(error);
  }
}

export async function editAddressAction(addressId: string, input: unknown) {
  try {
    const userId = await requireUserId();
    await editAddress(userId, addressId, input);
    return { ok: true as const, addresses: await listAddresses(userId) };
  } catch (error) {
    return failed(error);
  }
}

export async function removeAddressAction(addressId: string) {
  try {
    const userId = await requireUserId();
    await removeAddress(userId, addressId);
    return { ok: true as const, addresses: await listAddresses(userId) };
  } catch (error) {
    return failed(error);
  }
}

export async function setDefaultAddressAction(addressId: string) {
  try {
    const userId = await requireUserId();
    await setDefaultAddress(userId, addressId);
    return { ok: true as const, addresses: await listAddresses(userId) };
  } catch (error) {
    return failed(error);
  }
}

export async function removeCardAction(paymentMethodId: string) {
  try {
    const userId = await requireUserId();
    await removeAccountCard(userId, paymentMethodId);
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
