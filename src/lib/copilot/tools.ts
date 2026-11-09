import { tool } from "ai";
import { z } from "zod";
import { storeScoped } from "../db";
import { listingLabel } from "./cards";
import { searchListingMatches, type ListingSearch } from "./search";
import { PROPOSAL_MAX, QUANTITY_MAX, STOCK_STATUSES, type ChoiceCandidate, type ProposalKind } from "./types";

const CHECK_FAILED = "could not check that listing";
const NOT_FOUND = "listing not found";
const NOT_SEARCHED = "propose only a listing id that find_listings returned in this turn";
const WHOLE_NUMBERS = "whole numbers only";
const DOES_NOT_FIT = "that change does not fit this item";
const ALREADY = "already drafted";
const LIMIT = "limit of 5 changes";

export interface Draft {
  listingId: string;
  listingName: string;
  kind: ProposalKind;
  quantity: number | null;
  statusValue: string | null;
  beforeQty: number | null;
  beforeStatus: string | null;
}

/** A report that matched several listings. The owner picks one with a tap; nothing is drafted until then. */
export interface PendingChoice {
  candidates: ChoiceCandidate[];
  kind: ProposalKind;
  quantity: number | null;
  statusValue: string | null;
  nearOnly: boolean;
}

export interface DraftBook {
  drafts: Draft[];
  choices: PendingChoice[];
  searches: ListingSearch[];
  overflow: boolean;
  /** Listings already drafted or offered in a choice this turn. */
  listingIds: Set<string>;
  run<T>(fn: () => Promise<T>): Promise<T>;
}

export function createDraftBook(): DraftBook {
  const book: DraftBook = {
    drafts: [],
    choices: [],
    searches: [],
    overflow: false,
    listingIds: new Set(),
    run(fn) {
      const next = chain.then(fn, fn);
      chain = next.then(() => undefined, () => undefined);
      return next;
    },
  };
  let chain = Promise.resolve();
  return book;
}

export interface DraftListing {
  id: string;
  active: boolean;
  customName: string | null;
  stockMode: string;
  qty: number | null;
  status: string | null;
  masterProduct: { name: string } | null;
}

export const DRAFT_LISTING_SELECT = {
  id: true,
  active: true,
  customName: true,
  stockMode: true,
  qty: true,
  status: true,
  masterProduct: { select: { name: true } },
} as const;

export class DraftRefused extends Error {}

export function fitsStockMode(kind: string, stockMode: string): boolean {
  if (kind === "set_status") return stockMode === "status";
  return stockMode === "counted";
}

/** Checks the amount for a kind, before any listing is known. */
export function draftAmount(input: {
  kind: ProposalKind;
  quantity?: number | null;
  status?: string | null;
}): { quantity: number | null; statusValue: string | null } {
  if (input.kind === "set_status") {
    if (!input.status || !(STOCK_STATUSES as readonly string[]).includes(input.status)) throw new DraftRefused(DOES_NOT_FIT);
    return { quantity: null, statusValue: input.status };
  }
  const quantity = input.quantity;
  if (typeof quantity !== "number" || !Number.isInteger(quantity)) throw new DraftRefused(WHOLE_NUMBERS);
  const min = input.kind === "recount" ? 0 : 1;
  if (quantity < min || quantity > QUANTITY_MAX) throw new DraftRefused(WHOLE_NUMBERS);
  return { quantity, statusValue: null };
}

/** The one validation path for a draft on a known listing: the tool and a tapped choice both use it. */
export function draftFor(
  listing: DraftListing | null,
  input: { kind: ProposalKind; quantity: number | null; statusValue: string | null },
): Draft {
  if (!listing || !listing.active) throw new DraftRefused(NOT_FOUND);
  if (!fitsStockMode(input.kind, listing.stockMode)) throw new DraftRefused(DOES_NOT_FIT);
  const amount = draftAmount({ kind: input.kind, quantity: input.quantity, status: input.statusValue });
  return {
    listingId: listing.id,
    listingName: listingLabel(listing),
    kind: input.kind,
    quantity: amount.quantity,
    statusValue: amount.statusValue,
    beforeQty: listing.qty,
    beforeStatus: listing.status,
  };
}

const findSchema = z.object({
  query: z.string().max(200),
});

const proposeSchema = z.object({
  listingId: z.string().min(1).max(200),
  kind: z.enum(["restock", "counter_sale", "recount", "set_status"]),
  quantity: z.number().int().min(0).max(QUANTITY_MAX).optional(),
  status: z.enum(STOCK_STATUSES).optional(),
});

function searchResult(found: ListingSearch) {
  if (found.outcome === "one") {
    return { outcome: "one" as const, listings: found.listings };
  }
  if (found.outcome === "several") {
    return {
      outcome: found.nearOnly ? ("did_you_mean" as const) : ("several" as const),
      listings: found.listings,
      note: "Call propose_stock_change once with any one of these ids. The owner picks the item on screen.",
    };
  }
  return { outcome: "none" as const, listings: [] };
}

export function copilotTools(storeId: string, book: DraftBook) {
  return {
    find_listings: tool({
      description:
        "Search this store's active listings by item name. Returns outcome one, several, did_you_mean or none, and at most 5 listings. Does not change stock.",
      inputSchema: findSchema,
      execute: async ({ query }) => {
        let found: ListingSearch;
        try {
          found = await searchListingMatches(storeId, query);
        } catch {
          throw new Error("could not search listings");
        }
        book.searches.push(found);
        return searchResult(found);
      },
    }),
    propose_stock_change: tool({
      description:
        "Draft one stock change for a listing id that find_listings returned in this turn. When the search outcome was several or did_you_mean, the owner picks the item on screen instead. Does not write stock.",
      inputSchema: proposeSchema,
      execute: (input) => book.run(() => propose(storeId, book, input)),
    }),
  };
}

async function propose(storeId: string, book: DraftBook, input: z.infer<typeof proposeSchema>) {
  if (book.drafts.length + book.choices.length >= PROPOSAL_MAX) {
    book.overflow = true;
    throw new Error(LIMIT);
  }
  try {
    const amount = draftAmount(input);
    const single = book.searches.some((found) => found.outcome === "one" && found.listings[0].id === input.listingId);
    if (single) return await proposeOne(storeId, book, input.listingId, { kind: input.kind, ...amount });
    const group = [...book.searches].reverse().find((found) => (
      found.outcome === "several" && found.listings.some((listing) => listing.id === input.listingId)
    ));
    if (!group || group.outcome !== "several") throw new DraftRefused(NOT_SEARCHED);
    return offerChoice(book, group, { kind: input.kind, ...amount });
  } catch (error) {
    if (error instanceof DraftRefused) throw new Error(error.message);
    throw error;
  }
}

async function proposeOne(
  storeId: string,
  book: DraftBook,
  listingId: string,
  input: { kind: ProposalKind; quantity: number | null; statusValue: string | null },
) {
  let listing: DraftListing | null;
  try {
    listing = await storeScoped(storeId).listing.findUnique({ where: { id: listingId }, select: DRAFT_LISTING_SELECT });
  } catch {
    throw new Error(CHECK_FAILED);
  }
  const draft = draftFor(listing, input);
  if (book.listingIds.has(draft.listingId)) throw new DraftRefused(ALREADY);
  book.listingIds.add(draft.listingId);
  book.drafts.push(draft);
  return {
    drafted: true,
    listingId: draft.listingId,
    name: draft.listingName,
    kind: draft.kind,
    quantity: draft.quantity,
    status: draft.statusValue,
  };
}

function offerChoice(
  book: DraftBook,
  group: Extract<ListingSearch, { outcome: "several" }>,
  input: { kind: ProposalKind; quantity: number | null; statusValue: string | null },
) {
  if (!group.listings.some((listing) => fitsStockMode(input.kind, listing.stockMode))) throw new DraftRefused(DOES_NOT_FIT);
  if (group.listings.some((listing) => book.listingIds.has(listing.id))) throw new DraftRefused(ALREADY);
  for (const listing of group.listings) book.listingIds.add(listing.id);
  book.choices.push({
    candidates: group.listings.map((listing) => ({ listingId: listing.id, name: listing.name })),
    kind: input.kind,
    quantity: input.quantity,
    statusValue: input.statusValue,
    nearOnly: group.nearOnly,
  });
  return {
    drafted: false,
    ownerPicks: group.listings.map((listing) => listing.name),
    note: "Nothing is drafted yet. The owner taps the right item on screen.",
  };
}
