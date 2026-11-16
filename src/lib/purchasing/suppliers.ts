import { z } from "zod";
import { storeScoped, storeScopedTransaction } from "../db";
import { normalizeUsPhone } from "../notifications/phone";
import { LEAD_DAYS_MAX } from "../copilot/reorder-list";

export const SUPPLIER_CHANNELS = ["email", "whatsapp", "sms"] as const;
export type SupplierChannel = (typeof SUPPLIER_CHANNELS)[number];
export const SUPPLIER_LISTINGS_MAX = 2000;

export interface Actor {
  id: string;
  email: string;
}

export type Result = { ok: true } | { ok: false; message: string };

export interface SupplierView {
  id: string;
  name: string;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  channel: SupplierChannel;
  leadDays: number;
  listingIds: string[];
}

const blankToNull = (value: unknown) => (typeof value === "string" && value.trim() === "" ? null : value);

const supplierSchema = z.object({
  name: z.string().trim().min(1).max(120),
  contactName: z.preprocess(blankToNull, z.string().trim().max(120).nullable().optional()),
  email: z.preprocess(blankToNull, z.string().trim().max(254).email().nullable().optional()),
  phone: z.preprocess(blankToNull, z.string().trim().max(40).nullable().optional()),
  channel: z.enum(SUPPLIER_CHANNELS),
  leadDays: z.number().int().min(0).max(LEAD_DAYS_MAX),
});

export type SupplierInput = z.input<typeof supplierSchema>;

/** US numbers as in ADR-0001, or any number written with its + country code (wholesalers can be abroad). */
export function supplierPhone(raw: string): string | null {
  const us = normalizeUsPhone(raw);
  if (us.ok) return us.e164;
  const digits = raw.replace(/[\s().-]/g, "");
  return /^\+[1-9]\d{7,14}$/.test(digits) ? digits : null;
}

function parseSupplier(input: unknown):
  | { ok: true; data: Omit<SupplierView, "id" | "listingIds"> }
  | { ok: false; message: string } {
  const parsed = supplierSchema.safeParse(input);
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path[0];
    if (field === "email") return { ok: false, message: "Check the email address." };
    if (field === "leadDays") return { ok: false, message: `Lead time is 0 to ${LEAD_DAYS_MAX} whole days.` };
    return { ok: false, message: "Enter a name and pick how to send orders." };
  }
  const { name, contactName, email, phone: rawPhone, channel, leadDays } = parsed.data;
  const phone = rawPhone ? supplierPhone(rawPhone) : null;
  if (rawPhone && !phone) return { ok: false, message: "Check the phone number. Numbers outside the US start with +." };
  if (channel === "email" && !email) return { ok: false, message: "Add an email address to send orders by email." };
  if (channel !== "email" && !phone) return { ok: false, message: "Add a phone number to send orders by WhatsApp or text." };
  return { ok: true, data: { name, contactName: contactName ?? null, email: email ?? null, phone, channel, leadDays } };
}

/** Creates a supplier (id null) or updates one of this store's, with an audit row. */
export async function saveSupplier(
  storeId: string,
  id: string | null,
  input: unknown,
  actor: Actor,
): Promise<{ ok: true; id: string } | { ok: false; message: string }> {
  const parsed = parseSupplier(input);
  if (!parsed.ok) return parsed;
  const data = parsed.data;
  return storeScopedTransaction(storeId, async (tx) => {
    if (id === null) {
      const created = await tx.supplier.create({ data: { storeId, ...data } });
      await tx.auditLog.create({
        data: { storeId, actorId: actor.id, actorEmail: actor.email, action: "supplier.create", entityType: "supplier", entityId: created.id, after: data },
      });
      return { ok: true as const, id: created.id };
    }
    const before = await tx.supplier.findFirst({
      where: { id, storeId, archivedAt: null },
      select: { name: true, contactName: true, email: true, phone: true, channel: true, leadDays: true },
    });
    if (!before) return { ok: false as const, message: "That supplier is not in your store." };
    await tx.supplier.update({ where: { id }, data });
    await tx.auditLog.create({
      data: { storeId, actorId: actor.id, actorEmail: actor.email, action: "supplier.update", entityType: "supplier", entityId: id, before, after: data },
    });
    return { ok: true as const, id };
  });
}

/** Sets the listings a supplier supplies. A listing already with another supplier moves here. */
export async function setSupplierListings(storeId: string, supplierId: string, listingIds: string[], actor: Actor): Promise<Result> {
  const ids = [...new Set(listingIds)];
  if (ids.length > SUPPLIER_LISTINGS_MAX) return { ok: false, message: `At most ${SUPPLIER_LISTINGS_MAX} items.` };
  return storeScopedTransaction(storeId, async (tx) => {
    const supplier = await tx.supplier.findFirst({ where: { id: supplierId, storeId, archivedAt: null }, select: { id: true } });
    if (!supplier) return { ok: false, message: "That supplier is not in your store." };
    const found = await tx.listing.count({ where: { id: { in: ids }, storeId, active: true } });
    if (found !== ids.length) return { ok: false, message: "An item is no longer in your store. Reload the page." };
    const before = await tx.supplierListing.findMany({ where: { supplierId }, select: { listingId: true } });
    await tx.supplierListing.deleteMany({ where: { OR: [{ supplierId }, { listingId: { in: ids } }] } });
    await tx.supplierListing.createMany({ data: ids.map((listingId) => ({ storeId, supplierId, listingId })) });
    await tx.auditLog.create({
      data: {
        storeId,
        actorId: actor.id,
        actorEmail: actor.email,
        action: "supplier.listings",
        entityType: "supplier",
        entityId: supplierId,
        before: { listingIds: before.map((row) => row.listingId) },
        after: { listingIds: ids },
      },
    });
    return { ok: true };
  });
}

/** Archives a supplier with no open order. Its listings go back to unassigned. */
export async function archiveSupplier(storeId: string, supplierId: string, actor: Actor): Promise<Result> {
  return storeScopedTransaction(storeId, async (tx) => {
    const supplier = await tx.supplier.findFirst({ where: { id: supplierId, storeId, archivedAt: null }, select: { id: true } });
    if (!supplier) return { ok: false, message: "That supplier is not in your store." };
    const open = await tx.purchaseOrder.count({ where: { supplierId, status: { in: ["draft", "sent"] } } });
    if (open > 0) return { ok: false, message: "Finish or cancel this supplier's open orders first." };
    await tx.supplierListing.deleteMany({ where: { supplierId } });
    await tx.supplier.update({ where: { id: supplierId }, data: { archivedAt: new Date() } });
    await tx.auditLog.create({
      data: { storeId, actorId: actor.id, actorEmail: actor.email, action: "supplier.archive", entityType: "supplier", entityId: supplierId },
    });
    return { ok: true };
  });
}

export async function listSuppliers(storeId: string): Promise<SupplierView[]> {
  const rows = await storeScoped(storeId).supplier.findMany({
    where: { storeId, archivedAt: null },
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      contactName: true,
      email: true,
      phone: true,
      channel: true,
      leadDays: true,
      listings: { select: { listingId: true } },
    },
  });
  return rows.map(({ listings, channel, ...row }) => ({
    ...row,
    channel: channel as SupplierChannel,
    listingIds: listings.map((link) => link.listingId),
  }));
}
