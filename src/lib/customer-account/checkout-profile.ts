import { authPrisma, customerScoped, storeScoped } from "../db";
import { lastOrderContact } from "./order-history";
import { validPhone } from "./phone";
import { listAddresses, readAccountPhone } from "./address-book";
import { checkoutCardView } from "./checkout-card-view";
import { listAccountCards, type AccountCard } from "./saved-cards";

export interface CheckoutProfile {
  contactOnFile: boolean;
  card: { brand: string; last4: string } | null;
  addressOnFile: boolean;
}

export interface AccountAddressView {
  id: string;
  label: string;
  line1: string;
  line2: string | null;
  city: string;
  state: string;
  zip: string;
  notes: string | null;
  isDefault: boolean;
}

export interface AccountBookSnapshot {
  name: string;
  email: string;
  phone: string;
  addresses: AccountAddressView[];
  cards: AccountCard[];
  cardsUnavailable: boolean;
}

export interface CheckoutPrefill {
  contact: { name: string; email: string; phone: string };
  cards: AccountCard[];
  cardsUnavailable: boolean;
  defaultAddress: AccountAddressView | null;
  /** Every saved address, the default first, for checkout's picker (#763). */
  addresses: AccountAddressView[];
}

export async function loadAccountBook(userId: string, now = new Date()): Promise<AccountBookSnapshot> {
  const [user, phone, addresses, cardList] = await Promise.all([
    authPrisma.user.findUnique({ where: { id: userId }, select: { name: true, email: true } }),
    readAccountPhone(userId),
    listAddresses(userId),
    listAccountCards(userId, now),
  ]);
  return {
    name: user?.name ?? "",
    email: user?.email ?? "",
    phone: phone ?? "",
    addresses: addresses.map((address) => ({
      id: address.id,
      label: address.label,
      line1: address.line1,
      line2: address.line2,
      city: address.city,
      state: address.state,
      zip: address.zip,
      notes: address.notes,
      isDefault: address.isDefault,
    })),
    cards: cardList.cards,
    cardsUnavailable: cardList.unavailable,
  };
}

/** Full name falls back to the name on this store's last order when the account has none (#750). */
async function lastOrderName(storeId: string, userId: string): Promise<string> {
  const account = await storeScoped(storeId).customer.findFirst({ where: { storeId, userId }, select: { id: true } });
  return account ? (await lastOrderContact(storeId, account.id))?.name.trim() ?? "" : "";
}

export async function loadCheckoutPrefill(userId: string, storeId?: string, now = new Date()): Promise<CheckoutPrefill> {
  const book = await loadAccountBook(userId, now);
  const name = book.name.trim() || (storeId ? await lastOrderName(storeId, userId) : "");
  const defaultAddress = book.addresses.find((address) => address.isDefault) ?? null;
  return {
    contact: { name, email: book.email, phone: book.phone },
    cards: book.cards,
    cardsUnavailable: book.cardsUnavailable,
    defaultAddress,
    addresses: defaultAddress ? [defaultAddress, ...book.addresses.filter((address) => address !== defaultAddress)] : book.addresses,
  };
}

export async function getCheckoutProfile(userId: string, now = new Date()): Promise<CheckoutProfile> {
  const prefill = await loadCheckoutPrefill(userId, undefined, now);
  const view = checkoutCardView({
    signedIn: true,
    cards: prefill.cards.map((card) => ({
      id: card.id,
      brand: card.brand,
      last4: card.last4,
      expMonth: card.expMonth,
      expYear: card.expYear,
      consented: card.reusable,
      created: card.created,
    })),
    now,
  });
  const selected = view.selectable[0];
  const profile: CheckoutProfile = {
    contactOnFile: validPhone(prefill.contact.phone),
    card: selected ? { brand: selected.brand, last4: selected.last4 } : null,
    addressOnFile: prefill.defaultAddress !== null,
  };
  return profile;
}

export async function readProfileForSession(userId: string) {
  const row = await customerScoped(userId).platformCustomerProfile.findUnique({ where: { userId } });
  return row;
}
