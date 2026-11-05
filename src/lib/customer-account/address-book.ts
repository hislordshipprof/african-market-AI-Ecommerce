import { customerScopedTransaction, lockCustomerProfileRow } from "../db";
import {
  ADDRESS_CAP,
  ADDRESS_CAP_MESSAGE,
  ADDRESS_NOT_FOUND,
  normalizeAccountPhone,
  validateAddress,
  type AddressInput,
} from "./address-validation";

export interface AddressRecord extends AddressInput {
  id: string;
  isDefault: boolean;
  createdAt: Date;
}

type AddressClient = Parameters<Parameters<typeof customerScopedTransaction>[1]>[0];

async function withAccount<T>(userId: string, fn: (tx: AddressClient) => Promise<T>): Promise<T> {
  return customerScopedTransaction(userId, async (tx) => {
    await lockCustomerProfileRow(tx, userId);
    return fn(tx);
  });
}

function toRecord(row: {
  id: string;
  label: string;
  line1: string;
  line2: string | null;
  city: string;
  state: string;
  zip: string;
  notes: string | null;
  isDefault: boolean;
  createdAt: Date;
}): AddressRecord {
  return {
    id: row.id,
    label: row.label,
    line1: row.line1,
    line2: row.line2,
    city: row.city,
    state: row.state,
    zip: row.zip,
    notes: row.notes,
    isDefault: row.isDefault,
    createdAt: row.createdAt,
  };
}

export async function listAddresses(userId: string): Promise<AddressRecord[]> {
  return customerScopedTransaction(userId, async (tx) => {
    const rows = await tx.customerAddress.findMany({
      where: { userId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    return rows.map(toRecord);
  });
}

export async function addAddress(userId: string, input: unknown): Promise<AddressRecord> {
  const parsed = validateAddress(input);
  if (!parsed.ok) throw new Error(parsed.error);
  return withAccount(userId, async (tx) => {
    const count = await tx.customerAddress.count({ where: { userId } });
    if (count >= ADDRESS_CAP) throw new Error(ADDRESS_CAP_MESSAGE);
    const created = await tx.customerAddress.create({
      data: {
        userId,
        ...parsed.value,
        isDefault: count === 0,
      },
    });
    return toRecord(created);
  });
}

export async function editAddress(userId: string, addressId: string, input: unknown): Promise<AddressRecord> {
  const parsed = validateAddress(input);
  if (!parsed.ok) throw new Error(parsed.error);
  return withAccount(userId, async (tx) => {
    const existing = await tx.customerAddress.findFirst({ where: { id: addressId, userId } });
    if (!existing) throw new Error(ADDRESS_NOT_FOUND);
    const updated = await tx.customerAddress.update({
      where: { id: existing.id },
      data: parsed.value,
    });
    return toRecord(updated);
  });
}

export async function removeAddress(userId: string, addressId: string): Promise<void> {
  await withAccount(userId, async (tx) => {
    const existing = await tx.customerAddress.findFirst({ where: { id: addressId, userId } });
    if (!existing) throw new Error(ADDRESS_NOT_FOUND);
    await tx.customerAddress.delete({ where: { id: existing.id } });
    if (!existing.isDefault) return;
    const newest = await tx.customerAddress.findFirst({
      where: { userId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    if (newest) {
      await tx.customerAddress.update({ where: { id: newest.id }, data: { isDefault: true } });
    }
  });
}

export async function setDefaultAddress(userId: string, addressId: string): Promise<AddressRecord> {
  return withAccount(userId, async (tx) => {
    const existing = await tx.customerAddress.findFirst({ where: { id: addressId, userId } });
    if (!existing) throw new Error(ADDRESS_NOT_FOUND);
    await tx.customerAddress.updateMany({
      where: { userId, isDefault: true, NOT: { id: existing.id } },
      data: { isDefault: false },
    });
    const updated = await tx.customerAddress.update({
      where: { id: existing.id },
      data: { isDefault: true },
    });
    return toRecord(updated);
  });
}

export async function saveAccountPhone(userId: string, phone: unknown): Promise<string | null> {
  const parsed = normalizeAccountPhone(phone);
  if (!parsed.ok) throw new Error(parsed.error);
  await withAccount(userId, async (tx) => {
    await tx.platformCustomerProfile.update({
      where: { userId },
      data: { phone: parsed.phone },
    });
  });
  return parsed.phone;
}

export async function readAccountPhone(userId: string): Promise<string | null> {
  return customerScopedTransaction(userId, async (tx) => {
    const row = await tx.platformCustomerProfile.findUnique({ where: { userId } });
    return row?.phone ?? null;
  });
}
