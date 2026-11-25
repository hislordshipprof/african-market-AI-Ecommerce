import { tool } from "ai";
import { z } from "zod";
import { platform, storeScoped } from "../db";
import { listingLabel } from "./cards";
import { storeMayUse } from "../billing/plan";
import { MOVEMENT_DAYS, SALES_FLOOR, inventoryReport, type MovementRow } from "./inventory-report";
import { reorderSuggestions, type ReorderSuggestions } from "./reorder";
import { SALES_PERIODS, salesSummary, type PayoutReader, type SalesFigures } from "./sales-summary";
import { searchListingMatches, type ListingSearch } from "./search";
import { DraftError, draftToolResult, type DescriptionFacts, type DraftMakers, type PendingDraft } from "./draft-rows";
import { listingFacts, listingFixes, type ListingFacts } from "./listing-help";
import { PROPOSAL_MAX, QUANTITY_MAX, STOCK_STATUSES, type ChoiceCandidate, type ListingFix, type ProposalKind } from "./types";

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
  /** Every tool result this turn, as JSON: the only numbers the reply may quote besides the owner's. */
  toolResults: string[];
  /** Rows `inventory_report` returned this turn, for the fixed reply when a number fails the check. */
  report: MovementRow[];
  /** Periods `sales_summary` returned this turn, for the fixed reply when a number fails the check. */
  sales: SalesFigures[];
  /** Coupon, price and store-change drafts this turn (#819). */
  copilotDrafts: PendingDraft[];
  /** Listings `listings_to_fix` returned this turn, for the links card (#820); null when it was not called. */
  fixes: ListingFix[] | null;
  /** Listing facts read this turn, by listing id: a description is drafted only from these (#820). */
  facts: Map<string, DescriptionFacts>;
  /** Listings already drafted or offered in a choice this turn; each appears in one card or choice only. */
  listingIds: Set<string>;
  run<T>(fn: () => Promise<T>): Promise<T>;
}

export function createDraftBook(): DraftBook {
  const book: DraftBook = {
    drafts: [],
    choices: [],
    searches: [],
    overflow: false,
    toolResults: [],
    report: [],
    sales: [],
    copilotDrafts: [],
    fixes: null,
    facts: new Map(),
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

const reportSchema = z.object({
  query: z.string().max(200).optional(),
});

/** At most this many listings go to the model; the page shows them all. */
const REPORT_ROWS = 20;

const salesSchema = z.object({
  period: z.enum(SALES_PERIODS),
  from: z.string().max(10).optional(),
  to: z.string().max(10).optional(),
});

const couponSchema = z.object({
  code: z.string().max(40),
  percentOff: z.number().int().optional(),
  amountOff: z.number().optional(),
  minGoods: z.number().optional(),
  startsAt: z.string().max(16),
  endsAt: z.string().max(16).optional(),
  totalUses: z.number().int().optional(),
  usesPerCustomer: z.number().int().optional(),
  firstOrderOnly: z.boolean().optional(),
});

const priceSchema = z.object({
  query: z.string().max(200),
  variant: z.string().max(40).optional(),
  change: z.enum(["add", "set"]),
  cents: z.number().int().min(-1_000_000).max(1_000_000),
});

const storeChangeSchema = z.object({
  change: z.enum(["closed", "hours", "pause_delivery"]),
  date: z.string().max(10).optional(),
  open: z.string().max(5).optional(),
  close: z.string().max(5).optional(),
  until: z.string().max(16).optional(),
});

const factsSchema = z.object({
  query: z.string().max(200),
});

const descriptionSchema = z.object({
  listingId: z.string().min(1).max(200),
  text: z.string().max(2000),
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

function reportResult(rows: MovementRow[]) {
  return {
    windowDays: MOVEMENT_DAYS,
    salesFloor: SALES_FLOOR,
    note: "Sales are online orders plus counter sales the owner reported. Counter sales nobody reported are not counted.",
    total: rows.length,
    listings: rows.slice(0, REPORT_ROWS).map((row) => ({
      name: row.name,
      stockMode: row.stockMode,
      qty: row.qty,
      soldOnlineThisWeek: row.online7,
      soldOnlineWeekBefore: row.onlinePrior7,
      counterSalesReported: row.counter7,
      restocked: row.restocked7,
      shorts: row.short7,
      estimate: row.estimate.kind === "estimate"
        ? { perDay: row.estimate.perDay, daysLeft: row.estimate.daysLeft, outDate: row.estimate.outDate, outDay: row.estimate.outDay }
        : row.estimate.kind,
    })),
  };
}

function reorderResult(result: ReorderSuggestions) {
  return {
    leadDays: result.leadDays,
    coverDays: result.coverDays,
    windowDays: result.windowDays,
    note: "Suggested is units to order so stock lasts lead time plus cover at the last 28 days' pace. noCount means a status item marked low or out that sold; counts are not tracked. Nothing is ordered; the owner saves a list on the copilot page.",
    total: result.rows.length,
    listings: result.rows.slice(0, REPORT_ROWS).map((row) => ({
      name: row.name,
      onHand: row.onHand,
      soldLast28Days: row.sold28,
      suggested: row.suggested ?? "noCount",
    })),
  };
}

/** Records what the model saw, so the reply can be checked against it. */
function recorded<T>(book: DraftBook, result: T): T {
  book.toolResults.push(JSON.stringify(result));
  return result;
}

/** Where the turn came from: the page shows draft cards; WhatsApp does not, so it gets no draft tools. */
export interface ToolOptions {
  payouts?: PayoutReader | null;
  /** The page's draft makers, and the owner's message for the price draft's check that the owner named the item. */
  drafts?: { ownerText: string; make: DraftMakers };
}

export function copilotTools(storeId: string, book: DraftBook, options: ToolOptions = {}) {
  const payouts = options.payouts ?? null;
  return {
    ...(options.drafts ? draftTools(storeId, book, options.drafts.ownerText, options.drafts.make) : {}),
    listings_to_fix: tool({
      description:
        "This store's active listings that need fixing before shoppers see them well: missing a photo, an aisle, a description, or, for prepared food, owner-stated allergens. Returns the total and at most 20 listings with what each is missing. The page shows a link to edit each. Read only.",
      inputSchema: z.object({}),
      execute: async () => {
        let result: Awaited<ReturnType<typeof listingFixes>>;
        try {
          result = await listingFixes(storeId);
        } catch {
          throw new Error("could not read listings");
        }
        book.fixes = result.fixes;
        return recorded(book, {
          total: result.total,
          listings: result.fixes.map((fix) => ({ name: fix.name, missing: fix.missing })),
          note: options.drafts
            ? "The owner sees a link to edit each listing below your reply. Do not write links."
            : "This channel shows no links. Name each listing and say the owner can fix it under Products in store admin.",
        });
      },
    }),
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
        return recorded(book, searchResult(found));
      },
    }),
    inventory_report: tool({
      description:
        "Stock movement for this store's active listings, or the ones matching query: units sold online this week and the week before, counter sales and restocks the owner reported, shorts, and for counted listings with enough sales the average a day, days left and estimated out date. Read only.",
      inputSchema: reportSchema,
      execute: async ({ query }) => {
        let rows: MovementRow[];
        try {
          rows = (await inventoryReport(storeId, { query })).rows;
        } catch {
          throw new Error("could not read stock movement");
        }
        book.report.push(...rows.slice(0, REPORT_ROWS));
        return recorded(book, reportResult(rows));
      },
    }),
    reorder_suggestions: tool({
      description:
        "What to reorder: for counted listings, units to order so stock lasts the store's lead time plus cover at the last 28 days' sales; status listings marked low or out that sold get noCount. Read only: orders nothing and changes no stock.",
      inputSchema: z.object({}),
      execute: async () => {
        let result: ReorderSuggestions;
        try {
          if (!(await storeMayUse(storeId, "reorder-suggestions"))) {
            return recorded(book, { locked: true, note: "Reorder suggestions are on the Pro plan. The owner can upgrade on the Plan page." });
          }
          result = await reorderSuggestions(storeId);
        } catch {
          throw new Error("could not read reorder suggestions");
        }
        return recorded(book, reorderResult(result));
      },
    }),
    sales_summary: tool({
      description:
        "This store's sales for one period in its time zone: today, this_week and last_week (Monday to Sunday), this_month, or range with from and to as YYYY-MM-DD. Returns the dates used, orders, goods sales, units sold, refunds, net to store, average order, the top 5 items by quantity and by sales, orders from the directory, and the Stripe payout arriving in the period when known. Read only.",
      inputSchema: salesSchema,
      execute: async (input) => {
        let summary: Awaited<ReturnType<typeof salesSummary>>;
        try {
          summary = await salesSummary(storeId, input, payouts);
        } catch {
          throw new Error("could not read sales");
        }
        if (!summary.ok) throw new Error(summary.reason);
        book.sales.push(summary.figures);
        return recorded(book, summary.result);
      },
    }),
    propose_stock_change: tool({
      description:
        "Draft one stock change for a listing id that find_listings returned in this turn. When the search outcome was several or did_you_mean, the owner picks the item on screen instead. Does not write stock.",
      inputSchema: proposeSchema,
      execute: (input) => book.run(async () => recorded(book, await propose(storeId, book, input))),
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
  if (book.drafts.some((drafted) => drafted.listingId === draft.listingId)) throw new DraftRefused(ALREADY);
  book.listingIds.add(draft.listingId);
  book.drafts.push(draft);
  // A choice offered earlier this turn no longer lists the item drafted by name.
  for (const choice of book.choices) {
    choice.candidates = choice.candidates.filter((candidate) => candidate.listingId !== draft.listingId);
  }
  book.choices = book.choices.filter((choice) => choice.candidates.length > 0);
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
  const open = group.listings.filter((listing) => !book.listingIds.has(listing.id));
  if (open.length === 0) throw new DraftRefused(ALREADY);
  if (!open.some((listing) => fitsStockMode(input.kind, listing.stockMode))) throw new DraftRefused(DOES_NOT_FIT);
  for (const listing of open) book.listingIds.add(listing.id);
  book.choices.push({
    candidates: open.map((listing) => ({ listingId: listing.id, name: listing.name })),
    kind: input.kind,
    quantity: input.quantity,
    statusValue: input.statusValue,
    nearOnly: group.nearOnly,
  });
  return {
    drafted: false,
    ownerPicks: open.map((listing) => listing.name),
    note: "Nothing is drafted yet. The owner taps the right item on screen.",
  };
}

/** Turns a refusal into the tool error the model reads; anything else stays a failure. */
async function drafting(book: DraftBook, timeZone: string, make: () => Promise<PendingDraft> | PendingDraft) {
  if (book.drafts.length + book.choices.length + book.copilotDrafts.length >= PROPOSAL_MAX) {
    book.overflow = true;
    throw new Error(LIMIT);
  }
  let draft: PendingDraft;
  try {
    draft = await make();
  } catch (error) {
    if (error instanceof DraftError) throw new Error(error.message);
    throw new Error("could not draft that");
  }
  book.copilotDrafts.push(draft);
  return recorded(book, draftToolResult(draft, timeZone, new Date()));
}

function draftTools(storeId: string, book: DraftBook, ownerText: string, make: DraftMakers) {
  const store = () => platform.store.findUniqueOrThrow({
    where: { id: storeId },
    select: { hours: true, timezone: true, deliveryPausedUntil: true },
  });
  return {
    draft_coupon: tool({
      description:
        "Draft a store coupon for the owner to confirm on screen: code (3 to 20 letters, numbers or dashes), percentOff (1 to 90) or amountOff in dollars (1 to 100), minGoods in dollars, startsAt and endsAt as store-local YYYY-MM-DDTHH:MM, and optional totalUses, usesPerCustomer, firstOrderOnly. Creates nothing.",
      inputSchema: couponSchema,
      execute: (input) => book.run(async () => {
        const { timezone } = await store();
        return drafting(book, timezone, () => make.coupon(input, timezone));
      }),
    }),
    draft_price_change: tool({
      description:
        "Draft price changes for the listings matching query (the item as the owner named it), optionally one size (variant, e.g. \"5 lb\"): change add adds cents (negative lowers), change set sets the price to cents. Returns each line's before and after, at most 20. Changes no price.",
      inputSchema: priceSchema,
      execute: (input) => book.run(async () => {
        const { timezone } = await store();
        return drafting(book, timezone, () => make.prices(storeId, input, ownerText));
      }),
    }),
    listing_facts: tool({
      description:
        "The facts about one listing for a description: name, catalogue name, aisle, origin, sizes, storage, frozen, prepared, allergens (null when not stated) and the current description. query is the item as the owner named it. Call it before draft_description. Read only.",
      inputSchema: factsSchema,
      execute: async ({ query }) => {
        let found: ListingSearch;
        try {
          found = await searchListingMatches(storeId, query);
        } catch {
          throw new Error("could not search listings");
        }
        if (found.outcome !== "one") {
          return recorded(book, {
            found: false,
            listings: found.listings.map((listing) => listing.name),
            note: found.outcome === "none" ? "No listing matches. Ask the owner which item." : "Several listings match. Ask the owner which one.",
          });
        }
        let facts: ListingFacts | null;
        try {
          facts = await listingFacts(storeId, found.listings[0].id);
        } catch {
          throw new Error(CHECK_FAILED);
        }
        if (!facts) throw new Error(NOT_FOUND);
        const result = recorded(book, { found: true, ...facts });
        book.facts.set(facts.listingId, {
          listingId: facts.listingId,
          name: facts.name,
          currentDescription: facts.currentDescription,
          // Without the id: its digits are not a size the description may quote.
          text: JSON.stringify({ ...facts, listingId: undefined }),
        });
        return result;
      },
    }),
    draft_description: tool({
      description:
        "Draft a product description for a listing id that listing_facts returned in this turn, for the owner to edit and confirm on screen. Two or three short sentences, using only those facts: what it is, where it comes from, its size, how it is used. No health claims, prices, stock or availability. Changes nothing.",
      inputSchema: descriptionSchema,
      execute: (input) => book.run(async () => {
        const facts = book.facts.get(input.listingId);
        if (!facts) throw new Error("call listing_facts for this item first");
        const { timezone } = await store();
        return drafting(book, timezone, () => make.description(input, facts));
      }),
    }),
    draft_store_change: tool({
      description:
        "Draft a one-day store change for the owner to confirm: change closed with date (closed all that day); change hours with date and open and/or close as HH:MM 24-hour (the other time stays as usual); change pause_delivery with until as YYYY-MM-DD (to the end of that day) or YYYY-MM-DDTHH:MM. Dates are store-local. Never changes the weekly hours.",
      inputSchema: storeChangeSchema,
      execute: (input) => book.run(async () => {
        const row = await store();
        return drafting(book, row.timezone, () => make.storeChange(input, row, new Date()));
      }),
    }),
  };
}
