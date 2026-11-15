import { listProposalCategories, listStoreProposals } from "@/lib/catalog/product-proposals";
import { listPendingDrafts } from "@/lib/listing/photo-drafts";
import { requireStoreMember } from "@/lib/store-admin/session";
import { FromPhotosUi } from "./from-photos-ui";

export default async function FromPhotosPage() {
  const session = await requireStoreMember();
  const [drafts, proposals, categories] = await Promise.all([
    listPendingDrafts(session.store.id),
    listStoreProposals(session.store.id),
    listProposalCategories(),
  ]);

  return (
    <FromPhotosUi
      storeName={session.store.name}
      storeSlug={session.store.slug}
      isOwner={session.membership.role === "owner"}
      readOnly={session.membership.readOnly}
      drafts={drafts}
      proposals={proposals}
      categories={categories}
    />
  );
}
