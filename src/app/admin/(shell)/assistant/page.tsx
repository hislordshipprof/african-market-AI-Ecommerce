import { redirect } from "next/navigation";
import { requirePlatformAdmin } from "@/lib/admin/session";

/** The assistant is a sheet on every admin page now (#855); old links land on Home with it open. */
export default async function AdminAssistantPage() {
  await requirePlatformAdmin();
  redirect("/admin?assistant=open");
}
