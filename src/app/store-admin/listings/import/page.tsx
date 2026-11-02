import { requireStoreOwner } from "@/lib/store-admin/session";
import { CsvImportUi } from "./csv-import-ui";

export default async function CsvImportPage() {
  const session = await requireStoreOwner();

  return (
    <CsvImportUi
      storeName={session.store.name}
      storeSlug={session.store.slug}
    />
  );
}
