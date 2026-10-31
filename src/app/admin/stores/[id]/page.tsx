import { notFound } from "next/navigation";
import { getStoreById } from "@/lib/admin/actions";
import { requirePlatformAdmin } from "@/lib/admin/session";
import { StoreForm } from "../store-form";
import { InviteOwnerForm } from "./invite-owner-form";

export default async function EditStorePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requirePlatformAdmin();
  const { id } = await params;
  const store = await getStoreById(id);
  if (!store) notFound();

  return (
    <div className="mx-auto max-w-2xl px-6 py-8">
      <h1 className="mb-6 text-2xl font-bold text-[#15201A]">
        Edit: {store.name}
      </h1>
      <StoreForm mode="edit" store={store} />
      <div className="mt-8">
        <InviteOwnerForm storeId={store.id} />
      </div>
    </div>
  );
}
