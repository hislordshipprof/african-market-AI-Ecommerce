import { z } from "zod";
import { readFormFields } from "../security/parse-input";
import { parsePriceToCents } from "../listing/csv-import";

export interface CouponInput {
  code: string;
  kind: "percent" | "fixed";
  percentOff: number | null;
  amountOffCents: number | null;
  minGoodsCents: number;
  startsAt: Date;
  endsAt: Date | null;
  totalUses: number | null;
  usesPerCustomer: number | null;
  firstOrderOnly: boolean;
}

export type CouponFormResult = { ok: true; data: CouponInput } | { ok: false; error: string };

const FIELDS = ["code", "kind", "percentOff", "amountOff", "minGoods", "startsAt", "endsAt", "totalUses", "usesPerCustomer", "firstOrderOnly"] as const;
const LOCAL_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

const text = z.string().max(40).nullable().transform((v) => v?.trim() ?? "");
const schema = z.strictObject({
  code: text,
  kind: z.enum(["percent", "fixed"], { message: "Choose percent or a fixed amount." }),
  percentOff: text,
  amountOff: text,
  minGoods: text,
  startsAt: text,
  endsAt: text,
  totalUses: text,
  usesPerCustomer: text,
  firstOrderOnly: text,
});

/** Offset of `timeZone` from UTC at `at`, in ms. */
function zoneOffsetMs(at: Date, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(at).map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** A `datetime-local` value read as wall time in the store's zone. */
export function storeLocalToUtc(local: string, timeZone: string): Date | null {
  const m = LOCAL_TIME.exec(local);
  if (!m) return null;
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  if (Number.isNaN(wall)) return null;
  const first = wall - zoneOffsetMs(new Date(wall), timeZone);
  return new Date(wall - zoneOffsetMs(new Date(first), timeZone));
}

export function utcToStoreLocal(at: Date, timeZone: string): string {
  return new Date(at.getTime() + zoneOffsetMs(at, timeZone)).toISOString().slice(0, 16);
}

function wholeNumber(raw: string, min: number, max: number): number | null | undefined {
  if (raw === "") return null;
  if (!/^\d+$/.test(raw)) return undefined;
  const n = Number(raw);
  return n >= min && n <= max ? n : undefined;
}

export function parseCouponForm(formData: unknown, timeZone: string): CouponFormResult {
  const parsed = schema.safeParse(readFormFields(formData, FIELDS));
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the form." };
  const f = parsed.data;

  const code = f.code.toUpperCase();
  if (!/^[A-Z0-9-]{3,20}$/.test(code)) {
    return { ok: false, error: "Use 3 to 20 letters, numbers or dashes for the code." };
  }

  let percentOff: number | null = null;
  let amountOffCents: number | null = null;
  if (f.kind === "percent") {
    percentOff = wholeNumber(f.percentOff, 1, 90) ?? null;
    if (percentOff === null) return { ok: false, error: "Enter a percent from 1 to 90." };
  } else {
    amountOffCents = parsePriceToCents(f.amountOff);
    if (amountOffCents === null || amountOffCents < 100 || amountOffCents > 10_000) {
      return { ok: false, error: "Enter an amount from $1 to $100." };
    }
  }

  const minGoodsCents = f.minGoods === "" ? 0 : parsePriceToCents(f.minGoods);
  if (minGoodsCents === null || minGoodsCents < 0) return { ok: false, error: "Enter the minimum goods in dollars." };

  const startsAt = storeLocalToUtc(f.startsAt, timeZone);
  if (!startsAt) return { ok: false, error: "Enter a start date and time." };
  const endsAt = f.endsAt === "" ? null : storeLocalToUtc(f.endsAt, timeZone);
  if (f.endsAt !== "" && !endsAt) return { ok: false, error: "Enter a valid end date and time." };
  if (endsAt && endsAt <= startsAt) return { ok: false, error: "The end must be after the start." };

  const totalUses = wholeNumber(f.totalUses, 1, 1_000_000);
  if (totalUses === undefined) return { ok: false, error: "Total uses must be a whole number of 1 or more." };
  const usesPerCustomer = wholeNumber(f.usesPerCustomer, 1, 1_000);
  if (usesPerCustomer === undefined) return { ok: false, error: "Uses per customer must be a whole number of 1 or more." };

  return {
    ok: true,
    data: {
      code,
      kind: f.kind,
      percentOff,
      amountOffCents,
      minGoodsCents,
      startsAt,
      endsAt,
      totalUses,
      usesPerCustomer,
      firstOrderOnly: f.firstOrderOnly === "on",
    },
  };
}
