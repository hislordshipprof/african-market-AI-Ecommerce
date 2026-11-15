import { requirePlatformAdmin } from "@/lib/admin/session";
import { ASSIGNMENT_TIMEOUT_SECONDS, COURIER_WEIGHT_LIMIT_LB, readCourierSettings } from "@/lib/delivery/courier-settings";
import { CourierSettingsForm } from "./courier-settings-form";

export const metadata = { title: "Courier settings" };

/** Platform-wide courier settings (#535). Per-metro overrides wait for #577. */
export default async function CourierSettingsPage() {
  await requirePlatformAdmin();
  const settings = await readCourierSettings();

  return (
    <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-bold text-foreground">Courier settings</h1>
      <p className="mt-2 max-w-prose text-sm text-muted-foreground">
        These apply to every store. A change takes effect from the next quote or dispatch; deliveries already booked
        keep their courier.
      </p>
      <CourierSettingsForm settings={settings} limits={{ timeout: ASSIGNMENT_TIMEOUT_SECONDS, weight: COURIER_WEIGHT_LIMIT_LB }} />
    </div>
  );
}
