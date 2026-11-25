import { requireStoreOwner } from "@/lib/store-admin/session";
import { platform } from "@/lib/db";
import { readWeeklyHours, DEFAULT_WEEK } from "@/lib/store-settings/weekly-hours";
import { SLOT_FORMS, slotFormValues } from "@/lib/admin/slot-form";
import { SettingsForm } from "./settings-form";

export const dynamic = "force-dynamic";

export default async function StoreSettingsPage() {
  const { store } = await requireStoreOwner();
  // Fresh, not the cached store row: the form must show what was last saved.
  const row = await platform.store.findUniqueOrThrow({
    where: { id: store.id },
    select: { hours: true, timezone: true, timezoneSetAt: true, pickupEnabled: true, minimumOrderCents: true, phone: true, ownerStory: true, storeDeliveryEnabled: true, pickupSlotSettings: true, storeDeliverySlotSettings: true },
  });
  const hours = readWeeklyHours(row.hours);
  return (
    <SettingsForm
      storeName={store.name}
      storeSlug={store.slug}
      initial={{
        hours: hours?.week ?? DEFAULT_WEEK,
        timezone: row.timezone,
        pickupEnabled: row.pickupEnabled,
        minimumOrderCents: row.minimumOrderCents,
        phone: row.phone ?? "",
        about: row.ownerStory ?? "",
        slots: Object.assign({}, ...SLOT_FORMS.map((form) => slotFormValues(row[form.column], form.prefix))),
      }}
      unreadableDays={hours?.unreadable ?? []}
      hoursSaved={hours !== null}
      timezoneConfirmed={row.timezoneSetAt !== null}
      storeDeliveryEnabled={row.storeDeliveryEnabled}
    />
  );
}
