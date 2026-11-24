import { requirePlatformAdmin } from "@/lib/admin/session";
import { headers } from "next/headers";
import { storeWebAddress } from "@/lib/directory/links";
import { StoreForm } from "../store-form";

export default async function NewStorePage() {
  await requirePlatformAdmin();
  const host = (await headers()).get("host");

  return (
    <div className="mx-auto max-w-2xl px-6 py-8">
      <h1 className="mb-6 text-2xl font-bold text-foreground">Create store</h1>
      <StoreForm mode="create" webAddress={host ? storeWebAddress("your-store", host) : null} />
    </div>
  );
}
