import { listPendingDrafts } from "@/lib/listing/photo-drafts";
import { requireStoreMember } from "@/lib/store-admin/session";
import { FromPhotosUi } from "./from-photos-ui";

export default async function FromPhotosPage() {
  const session = await requireStoreMember();
  const drafts = await listPendingDrafts(session.store.id);

  return (
    <FromPhotosUi
      storeName={session.store.name}
      storeSlug={session.store.slug}
      isOwner={session.membership.role === "owner"}
      readOnly={session.membership.readOnly}
      drafts={drafts}
    />
  );
}
