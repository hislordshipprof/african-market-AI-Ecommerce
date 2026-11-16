"use server";

import { z } from "zod";
import { requireStoreOwner } from "./session";
import { parseInput } from "../security/parse-input";
import { saveStoreShipping, type StoreShippingResult } from "../shipping/store-shipping";

const shippingSchema = z.strictObject({ handlingDays: z.number().int().min(1).max(10).nullable() });

/** Owner only. The store is the session's; the input never names one. */
export async function updateStoreShipping(input: unknown): Promise<StoreShippingResult> {
  const session = await requireStoreOwner();
  const parsed = parseInput(shippingSchema, input);
  if (!parsed.ok) return { ok: false, message: "Handling time is 1 to 10 business days." };
  return saveStoreShipping(session.store.id, parsed.data.handlingDays, { id: session.user.id, email: session.user.email });
}
