import { z } from "zod";
import { parseInput } from "../security/parse-input";

export const ORDER_SEARCH_PAGE_SIZE = 50;

export const ORDER_STATUSES = [
  "AUTHORIZED",
  "ACCEPTED",
  "PICKING",
  "SUBSTITUTION_PENDING",
  "CANCELLING",
  "CAPTURING",
  "READY",
  "AWAITING_PICKUP",
  "COURIER_REQUESTED",
  "COURIER_ASSIGNED",
  "PICKED_UP",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
  "COMPLETED",
  "CANCELLED",
  "REFUND_FAILED",
  "PARTIALLY_REFUNDED",
  "REFUNDED",
] as const;

export const ORDER_FULFILLMENTS = ["pickup", "store-delivery", "courier"] as const;

export const ORDER_SEARCH_FIELDS = ["storeId", "number", "email", "phone", "status", "fulfillment", "from", "to", "cursor"] as const;

export type OrderCursor = { createdAt: Date; id: string };

export type OrderSearchFilters = {
  storeId: string | null;
  number: number | null;
  email: string | null;
  phone: string | null;
  status: (typeof ORDER_STATUSES)[number] | null;
  fulfillment: (typeof ORDER_FULFILLMENTS)[number] | null;
  from: string | null;
  to: string | null;
  cursor: OrderCursor | null;
};

export type OrderSearchRow = {
  id: string;
  storeName: string;
  storeTimezone: string;
  number: number;
  status: string;
  fulfillment: string;
  totalAuthorizedCents: number;
  capturedAmountCents: number | null;
  createdAt: Date;
};

export type OrderSearchField = (typeof ORDER_SEARCH_FIELDS)[number];

/** The search form's state: the fields as typed, then the page shown. `rows` is null before the first search. */
export type OrderSearchState = {
  values: Partial<Record<OrderSearchField, string>>;
  error: string | null;
  rows: OrderSearchRow[] | null;
  nextCursor: string | null;
  page: number;
};

export const INITIAL_ORDER_SEARCH: OrderSearchState = { values: {}, error: null, rows: null, nextCursor: null, page: 0 };

const ID = /^[A-Za-z0-9_-]{1,64}$/;

export function encodeOrderCursor(cursor: OrderCursor): string {
  return Buffer.from(`${cursor.createdAt.toISOString()}|${cursor.id}`).toString("base64url");
}

function decodeOrderCursor(raw: string): OrderCursor | null {
  const [at, id, ...rest] = Buffer.from(raw, "base64url").toString("utf8").split("|");
  if (rest.length > 0 || !at || !id || !ID.test(id)) return null;
  const createdAt = new Date(at);
  if (Number.isNaN(createdAt.getTime()) || createdAt.toISOString() !== at) return null;
  return { createdAt, id };
}

function isCalendarDate(value: string): boolean {
  const at = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(at.getTime()) && at.toISOString().slice(0, 10) === value;
}

const optional = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((value) => (typeof value === "string" && value.trim() === "" ? null : value ?? null), schema.nullable());

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isCalendarDate, "Enter a real date.");

const searchSchema = z.object({
  storeId: optional(z.string().regex(ID, "Choose a store from the list.")),
  number: optional(z.string().trim().regex(/^\d{1,9}$/, "An order number is digits only.").transform(Number)),
  email: optional(z.string().trim().toLowerCase().max(254).email("Enter the customer's full email address.")),
  phone: optional(z.string().trim().max(40)),
  status: optional(z.enum(ORDER_STATUSES, "Choose a status from the list.")),
  fulfillment: optional(z.enum(ORDER_FULFILLMENTS, "Choose a fulfillment from the list.")),
  from: optional(day),
  to: optional(day),
  cursor: optional(
    z.string().max(200).transform((raw, ctx) => {
      const cursor = decodeOrderCursor(raw);
      if (!cursor) ctx.addIssue({ code: "custom", message: "That page link is not valid. Search again." });
      return cursor ?? z.NEVER;
    }),
  ),
});

/** The search form's fields, checked. Email is lowercased the way checkout stores it; everything else is compared exactly. */
export function parseOrderSearch(
  input: Partial<Record<(typeof ORDER_SEARCH_FIELDS)[number], unknown>>,
): { ok: true; filters: OrderSearchFilters } | { ok: false; error: string } {
  const parsed = parseInput(searchSchema, input);
  if (!parsed.ok) return { ok: false, error: parsed.issues[0] ?? "Check the search fields." };
  const filters = parsed.data as OrderSearchFilters;
  if (filters.number !== null && filters.storeId === null) {
    return { ok: false, error: "Choose a store to search by order number." };
  }
  if (filters.from && filters.to && filters.to < filters.from) {
    return { ok: false, error: "The end date is before the start date." };
  }
  return { ok: true, filters };
}
