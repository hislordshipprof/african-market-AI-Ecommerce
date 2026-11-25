import Link from "next/link";
import { requirePlatformAdmin } from "@/lib/admin/session";
import { ASSIGNMENT_TIMEOUT_SECONDS, COURIER_WEIGHT_LIMIT_LB, readCourierSettings } from "@/lib/delivery/courier-settings";
import { CourierSettingsForm } from "./courier-settings-form";

export const metadata = { title: "Courier settings" };

/** Platform-wide courier settings (#535). A metro can override the mode, the timeout and switch a courier off (#577). */
export default async function CourierSettingsPage() {
  await requirePlatformAdmin();
  const settings = await readCourierSettings();

  return (
    <div className="max-w-3xl px-4 py-6 sm:px-6 lg:px-8">
      <h1 className="text-2xl font-bold text-foreground">Courier settings</h1>
      <p className="mt-2 max-w-prose text-sm text-muted-foreground">
        These apply to every store, except where a store&apos;s <Link href="/admin/metros" className="font-medium text-primary underline-offset-4 hover:underline">metro</Link> sets
        its own mode or timeout, or switches a courier off. A courier off here is off everywhere. A change takes effect from
        the next quote or dispatch; deliveries already booked keep their courier.
      </p>
      <CourierSettingsForm settings={settings} limits={{ timeout: ASSIGNMENT_TIMEOUT_SECONDS, weight: COURIER_WEIGHT_LIMIT_LB }} />
    </div>
  );
}
