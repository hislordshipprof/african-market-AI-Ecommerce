"use server";

import { z } from "zod";
import { ALLERGENS, DIETARY_CLAIMS } from "../catalog/attributes";
import { correctListingAttributes, ownerListingAttributes } from "../catalog/listing-attributes";
import { parseInput } from "../security/parse-input";
import { requireStoreOwner } from "../store-admin/session";
import { toActor } from "./service";

const ownerStatus = z.enum(["known", "unknown", "catalog"]);
const correctionSchema = z.strictObject({
  listingId: z.string().min(1).max(200),
  ingredients: z.strictObject({ status: ownerStatus, names: z.array(z.string().max(100)).max(60) }).optional(),
  allergens: z.strictObject({ status: ownerStatus, values: z.array(z.enum(ALLERGENS)).max(ALLERGENS.length) }).optional(),
  dietary: z.strictObject({ status: ownerStatus, values: z.array(z.enum(DIETARY_CLAIMS)).max(DIETARY_CLAIMS.length) }).optional(),
});

export async function getListingAttributesAction(listingId: string) {
  const session = await requireStoreOwner();
  const id = parseInput(z.string().min(1).max(200), listingId);
  if (!id.ok) return { error: "Listing not found" };
  const attributes = await ownerListingAttributes(session.store.id, id.data);
  return attributes ? { attributes } : { error: "Listing not found" };
}

export async function correctListingAttributesAction(input: z.input<typeof correctionSchema>) {
  const session = await requireStoreOwner();
  const parsed = parseInput(correctionSchema, input);
  if (!parsed.ok) return { error: "Check the attributes and try again" };
  const { listingId, ...correction } = parsed.data;
  const result = await correctListingAttributes(session.store.id, toActor(session.user), listingId, correction);
  return result.ok ? { success: true } : { error: result.error };
}
