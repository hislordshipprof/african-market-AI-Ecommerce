"use server";

import { z } from "zod";
import { requireStoreOwner } from "./session";
import { parseInput } from "../security/parse-input";
import { CUISINE_TAGS_MAX, LISTING_BLURB_MAX } from "../directory/listing-fields";
import { saveDirectoryListing, type ListingResult } from "../directory/listing";

const listingSchema = z.strictObject({
  listed: z.boolean(),
  // Whitespace is collapsed before the 160-character check, so the raw cap is looser.
  blurb: z.string().max(LISTING_BLURB_MAX * 4),
  cuisineTags: z.array(z.string().max(40)).max(CUISINE_TAGS_MAX),
});

/** Owner only. The store is the session's; the input never names one. */
export async function updateDirectoryListing(input: unknown): Promise<ListingResult> {
  const session = await requireStoreOwner();
  const parsed = parseInput(listingSchema, input);
  if (!parsed.ok) return { ok: false, message: `Keep the description to ${LISTING_BLURB_MAX} characters and pick up to ${CUISINE_TAGS_MAX} cuisines.` };
  return saveDirectoryListing(session.store.id, parsed.data, { id: session.user.id, email: session.user.email });
}
