import { requireStoreOwner } from "@/lib/store-admin/session";
import { CUISINE_TAG_VALUES, type CuisineTag } from "@/lib/directory/listing-fields";
import { AiCatalogCard } from "./ai-catalog-card";
import { DirectoryListingForm } from "./directory-listing-form";

export const dynamic = "force-dynamic";

export default async function DirectoryListingPage() {
  const { store } = await requireStoreOwner();
  const known = new Set<string>(CUISINE_TAG_VALUES);
  return (
    <DirectoryListingForm
      storeName={store.name}
      storeSlug={store.slug}
      place={[store.city, store.state].filter(Boolean).join(", ")}
      located={store.lat != null && store.lng != null}
      status={store.status}
      initial={{
        listed: store.listed,
        blurb: store.listingBlurb ?? "",
        cuisineTags: store.cuisineTags.filter((tag): tag is CuisineTag => known.has(tag)),
      }}
    >
      <AiCatalogCard initial={store.aiCatalogReadable} />
    </DirectoryListingForm>
  );
}
