import { requirePlatformAdmin } from "@/lib/admin/session";
import { StoreForm } from "../store-form";

export default async function NewStorePage() {
  await requirePlatformAdmin();

  return (
    <div className="mx-auto max-w-2xl px-6 py-8">
      <h1 className="mb-6 text-2xl font-bold text-[#15201A]">Create store</h1>
      <StoreForm mode="create" />
    </div>
  );
}
