import { redirect } from "next/navigation";
import { requirePlatformAdmin } from "@/lib/admin/session";

export default async function AdminDashboard() {
  await requirePlatformAdmin();
  redirect("/admin/stores");
}
