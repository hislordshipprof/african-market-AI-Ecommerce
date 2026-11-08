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

const SOLD = /^sold\s+(\d+)\s+(.+?)\s+at the counter\.?$/i;
const COUNTED = /^counted\s+(\d+)\s+(?:bags?\s+of\s+)?(.+?)\.?$/i;
const GOT = /^got\s+(\d+)\s+(?:bags?\s+of\s+|of\s+)?(.+?)\.?$/i;
const OUT = /^(?:we are |we're )?out of\s+(.+?)\.?$/i;
const LOW = /^running low(?:\s+on)?\s+(.+?)\.?$/i;

/** When the model describes a change instead of drafting it, one clear report still becomes a card. */
export async function draftUnambiguousReport(storeId: string, book: DraftBook, text: string): Promise<void> {
  if (book.drafts.length > 0) return;
  const intent = readIntent(text);
  if (!intent) return;
  let matches: Awaited<ReturnType<typeof searchListingMatches>>;
  try {
    matches = await searchListingMatches(storeId, intent.query);
  } catch {
    return;
  }
  if (matches.length !== 1) return;
  const listing = matches[0];
  const input = proposalFor(intent, listing);
  if (!input) return;
  try {
    await book.run(() => propose(storeId, book, input));
  } catch {
    // The model's own reply stands when the draft does not fit.
  }
}

function readIntent(text: string): { query: string; kind: ProposalKind | "low"; quantity?: number } | null {
  const cleaned = text.replace(/\s+/g, " ").trim();
  const sold = cleaned.match(SOLD);
  if (sold) return { kind: "counter_sale", quantity: Number(sold[1]), query: sold[2].trim() };
  const counted = cleaned.match(COUNTED);
  if (counted) return { kind: "recount", quantity: Number(counted[1]), query: counted[2].trim() };
  const got = cleaned.match(GOT);
  if (got) return { kind: "restock", quantity: Number(got[1]), query: got[2].trim() };
  const out = cleaned.match(OUT);
  if (out) return { kind: "recount", quantity: 0, query: out[1].trim() };
  const low = cleaned.match(LOW);
  if (low) return { kind: "low", query: low[1].trim() };
  return null;
}

function proposalFor(
  intent: { kind: ProposalKind | "low"; quantity?: number },
  listing: { id: string; stockMode: string },
): { listingId: string; kind: ProposalKind; quantity?: number; status?: "in_stock" | "low" | "out_of_stock" } | null {
  if (intent.kind === "low") {
    return listing.stockMode === "status"
      ? { listingId: listing.id, kind: "set_status", status: "low" }
      : null;
  }
  if (intent.quantity === 0 && intent.kind === "recount") {
    return listing.stockMode === "status"
      ? { listingId: listing.id, kind: "set_status", status: "out_of_stock" }
      : { listingId: listing.id, kind: "recount", quantity: 0 };
  }
  if (listing.stockMode === "status" && intent.kind === "restock") {
    return { listingId: listing.id, kind: "set_status", status: "in_stock" };
  }
  if (listing.stockMode !== "counted") return null;
  if (intent.quantity === undefined || intent.quantity > QUANTITY_MAX) return null;
  if (intent.kind !== "recount" && intent.quantity < 1) return null;
  return { listingId: listing.id, kind: intent.kind, quantity: intent.quantity };
}

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
