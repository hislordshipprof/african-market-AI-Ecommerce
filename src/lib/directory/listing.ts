import { platformAdminTransaction } from "../db";
import { revalidateStore } from "../get-store";
import { queueStoreRequestNotices } from "./store-requests";
import { CUISINE_TAGS, CUISINE_TAGS_MAX, LISTING_BLURB_MAX, blurbLength, isCuisineTag, normalizeBlurb, type CuisineTag } from "./listing-fields";

export interface DirectoryListing {
  listed: boolean;
  listingBlurb: string | null;
  cuisineTags: CuisineTag[];
}

export type ListingResult = { ok: true } | { ok: false; message: string };

const refuse = (message: string): ListingResult => ({ ok: false, message });

/** The owner's listing switch, blurb and cuisine tags, with an audit row (#450). */
export async function saveDirectoryListing(
  storeId: string,
  input: { listed: boolean; blurb: string; cuisineTags: readonly string[] },
  actor: { id: string; email: string },
): Promise<ListingResult> {
  const listingBlurb = normalizeBlurb(input.blurb);
  if (listingBlurb && blurbLength(listingBlurb) > LISTING_BLURB_MAX) {
    return refuse(`Keep the description to ${LISTING_BLURB_MAX} characters.`);
  }
  if (!input.cuisineTags.every(isCuisineTag)) return refuse("Pick cuisines from the list.");
  if (new Set(input.cuisineTags).size > CUISINE_TAGS_MAX) return refuse(`Pick up to ${CUISINE_TAGS_MAX} cuisines.`);
  const cuisineTags = CUISINE_TAGS.map((tag) => tag.value).filter((value) => input.cuisineTags.includes(value));
  const after: DirectoryListing = { listed: input.listed, listingBlurb, cuisineTags };

  const store = await platformAdminTransaction(async (tx) => {
    const before = await tx.store.findUnique({
      where: { id: storeId },
      select: { id: true, slug: true, customDomain: true, listed: true, listingBlurb: true, cuisineTags: true },
    });
    if (!before) return null;
    if (
      before.listed === after.listed &&
      before.listingBlurb === after.listingBlurb &&
      before.cuisineTags.join(",") === after.cuisineTags.join(",")
    ) {
      return before;
    }
    await tx.store.update({ where: { id: storeId }, data: after });
    await tx.auditLog.create({
      data: {
        storeId,
        actorId: actor.id,
        actorEmail: actor.email,
        action: "store.directory_listing",
        entityType: "store",
        entityId: storeId,
        before: { listed: before.listed, listingBlurb: before.listingBlurb, cuisineTags: before.cuisineTags },
        after: { ...after },
      },
    });
    return before;
  });
  if (!store) return refuse("Store not found.");
  revalidateStore(store);
  if (!store.listed && after.listed) await queueStoreRequestNotices(storeId);
  return { ok: true };
}
