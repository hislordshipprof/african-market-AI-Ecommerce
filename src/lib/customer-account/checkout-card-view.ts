import { isCardExpired } from "./card-expiry";

export interface SavedCardFact {
  id: string;
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
  /** True when this account consented to reuse the card. */
  consented: boolean;
  created: number;
}

export interface CheckoutCardView {
  showSaveTick: boolean;
  saveTickDefault: false;
  selectable: SavedCardFact[];
  expired: SavedCardFact[];
  preselectedId: string | null;
  showCardForm: boolean;
}

/**
 * Newest consented unexpired card is pre-selected. Guests see no tick.
 * The tick default is the literal false.
 */
export function checkoutCardView(input: {
  signedIn: boolean;
  cards: SavedCardFact[];
  now: Date;
}): CheckoutCardView {
  if (!input.signedIn) {
    return {
      showSaveTick: false,
      saveTickDefault: false,
      selectable: [],
      expired: [],
      preselectedId: null,
      showCardForm: true,
    };
  }
  const ordered = input.cards.toSorted((a, b) => b.created - a.created || (a.id < b.id ? 1 : -1));
  const expired = ordered.filter((card) => isCardExpired(card.expMonth, card.expYear, input.now));
  const selectable = ordered.filter(
    (card) => card.consented && !isCardExpired(card.expMonth, card.expYear, input.now),
  );
  const preselectedId = selectable[0]?.id ?? null;
  return {
    showSaveTick: true,
    saveTickDefault: false,
    selectable,
    expired,
    preselectedId,
    showCardForm: preselectedId === null,
  };
}
