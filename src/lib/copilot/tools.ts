import { tool } from "ai";
import { z } from "zod";
import { storeScoped } from "../db";
import { listingLabel } from "./cards";
import { searchListingMatches } from "./search";
import { PROPOSAL_MAX, QUANTITY_MAX, STOCK_STATUSES, type ProposalKind } from "./types";

const CHECK_FAILED = "could not check that listing";
const NOT_FOUND = "listing not found";
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

export interface DraftBook {
  drafts: Draft[];
  overflow: boolean;
  listingIds: Set<string>;
  run<T>(fn: () => Promise<T>): Promise<T>;
}

export function createDraftBook(): DraftBook {
  const book: DraftBook = {
    drafts: [],
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

const findSchema = z.object({
  query: z.string().max(200),
});

const proposeSchema = z.object({
  listingId: z.string().min(1).max(200),
  kind: z.enum(["restock", "counter_sale", "recount", "set_status"]),
  quantity: z.number().int().min(0).max(QUANTITY_MAX).optional(),
  status: z.enum(STOCK_STATUSES).optional(),
});

export function copilotTools(storeId: string, book: DraftBook) {
  return {
    find_listings: tool({
      description: "Search this store's active listings by name. Returns at most 5. Does not change stock.",
      inputSchema: findSchema,
      execute: async ({ query }) => {
        try {
          const listings = await searchListingMatches(storeId, query);
          return { listings };
        } catch {
          throw new Error("could not search listings");
        }
      },
    }),
    propose_stock_change: tool({
      description: "Draft one stock change for a listing id returned by find_listings. Does not write stock.",
      inputSchema: proposeSchema,
      execute: (input) => book.run(() => propose(storeId, book, input)),
    }),
  };
}

async function propose(
  storeId: string,
  book: DraftBook,
  input: z.infer<typeof proposeSchema>,
): Promise<{ drafted: true; listingId: string; name: string; kind: ProposalKind; quantity: number | null; status: string | null }> {
  if (book.drafts.length >= PROPOSAL_MAX) {
    book.overflow = true;
    throw new Error(LIMIT);
  }
  let listing: {
    id: string;
    active: boolean;
    customName: string | null;
    stockMode: string;
    qty: number | null;
    status: string | null;
    masterProduct: { name: string } | null;
  } | null;
  try {
    listing = await storeScoped(storeId).listing.findUnique({
      where: { id: input.listingId },
      select: {
        id: true,
        active: true,
        customName: true,
        stockMode: true,
        qty: true,
        status: true,
        masterProduct: { select: { name: true } },
      },
    });
  } catch {
    throw new Error(CHECK_FAILED);
  }
  if (!listing || !listing.active) throw new Error(NOT_FOUND);

  const kind = input.kind;
  const counted = kind === "restock" || kind === "counter_sale" || kind === "recount";
  if (counted && listing.stockMode !== "counted") throw new Error(DOES_NOT_FIT);
  if (kind === "set_status" && listing.stockMode !== "status") throw new Error(DOES_NOT_FIT);

  let quantity: number | null = null;
  let statusValue: string | null = null;
  if (kind === "set_status") {
    if (!input.status) throw new Error(DOES_NOT_FIT);
    statusValue = input.status;
  } else if (typeof input.quantity !== "number" || !Number.isInteger(input.quantity)) {
    throw new Error(WHOLE_NUMBERS);
  } else if (kind === "recount" && (input.quantity < 0 || input.quantity > QUANTITY_MAX)) {
    throw new Error(WHOLE_NUMBERS);
  } else if (kind !== "recount" && (input.quantity < 1 || input.quantity > QUANTITY_MAX)) {
    throw new Error(WHOLE_NUMBERS);
  } else {
    quantity = input.quantity;
  }

  if (book.listingIds.has(listing.id)) throw new Error(ALREADY);
  book.listingIds.add(listing.id);
  book.drafts.push({
    listingId: listing.id,
    listingName: listingLabel(listing),
    kind,
    quantity,
    statusValue,
    beforeQty: listing.qty,
    beforeStatus: listing.status,
  });
  return {
    drafted: true,
    listingId: listing.id,
    name: listingLabel(listing),
    kind,
    quantity,
    status: statusValue,
  };
}
