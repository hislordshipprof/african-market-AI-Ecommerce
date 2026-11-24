"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ArrowLeft, Check, CircleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { HoursEditor } from "@/components/store-hours/hours-editor";
import { VALID_US_TIMEZONES } from "@/lib/admin/timezone";
import { weeklyHoursError, type WeekDay, type WeekHours } from "@/lib/store-settings/weekly-hours";
import { STORE_ABOUT_MAX } from "@/lib/store-settings/fields";
import { updateStoreSettings } from "@/lib/store-admin/settings-actions";

const ZONE_NAMES: Record<string, string> = {
  "America/New_York": "Eastern",
  "America/Chicago": "Central",
  "America/Denver": "Mountain",
  "America/Phoenix": "Arizona (no daylight saving)",
  "America/Los_Angeles": "Pacific",
  "America/Anchorage": "Alaska",
  "Pacific/Honolulu": "Hawaii",
};

interface Values {
  hours: WeekHours;
  timezone: string;
  pickupEnabled: boolean;
  minimumOrderCents: number;
  phone: string;
  about: string;
}

interface Props {
  storeName: string;
  storeSlug: string;
  initial: Values;
  unreadableDays: WeekDay[];
  /** False while the store has no hours saved: the editor shows a starting week. */
  hoursSaved: boolean;
  timezoneConfirmed: boolean;
  storeDeliveryEnabled: boolean;
}

function dollars(cents: number): string {
  return cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2);
}

/** The owner's store settings (#786). Delivery stays with the platform team; one minimum covers every order. */
export function SettingsForm({ storeName, storeSlug, initial, unreadableDays, hoursSaved, timezoneConfirmed, storeDeliveryEnabled }: Props) {
  const searchParams = useSearchParams();
  const storeParam = searchParams.get("store") ?? storeSlug;
  const [values, setValues] = useState(initial);
  const [minimum, setMinimum] = useState(dollars(initial.minimumOrderCents));
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  function change(next: Partial<Values>) {
    setValues((current) => ({ ...current, ...next }));
    setNotice(null);
  }

  function save(event: React.FormEvent) {
    event.preventDefault();
    const minimumOrderCents = Math.round(Number(minimum) * 100);
    const problem = !/^\d+(\.\d{1,2})?$/.test(minimum.trim()) ? "Enter the minimum order in dollars, like 25 or 0." : weeklyHoursError(values.hours);
    if (problem) {
      setNotice({ ok: false, text: problem });
      return;
    }
    startTransition(async () => {
      const result = await updateStoreSettings({ ...values, minimumOrderCents });
      setNotice(result.ok ? { ok: true, text: "Saved. Shoppers see the new settings now." } : { ok: false, text: result.message });
    });
  }

  return (
    <div className="min-h-dvh bg-background">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-2xl items-center gap-3 px-4 py-3">
          <Link href={`/store-admin?store=${storeParam}`} aria-label="Back to store admin">
            <Button variant="ghost" size="icon" className="size-9" tabIndex={-1}>
              <ArrowLeft className="size-4" />
            </Button>
          </Link>
          <div>
            <h1 className="text-base font-semibold text-foreground">Settings</h1>
            <p className="text-xs text-muted-foreground">{storeName}</p>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-2xl px-4 py-6">
        <form onSubmit={save} className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Opening hours</CardTitle>
              <CardDescription>
                Shoppers can order while you are open. Pickup and delivery times are offered inside these hours.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              {!hoursSaved && (
                <p role="note" className="flex items-start gap-2 rounded-lg bg-muted px-3 py-2 text-sm text-foreground">
                  <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                  Your hours are not set yet. Check each day, then save.
                </p>
              )}
              <HoursEditor week={values.hours} onChange={(hours) => change({ hours })} unreadable={unreadableDays} />
              <div className="flex flex-col gap-2">
                <Label htmlFor="timezone">Time zone</Label>
                <Select value={values.timezone} onValueChange={(timezone) => timezone && change({ timezone })}>
                  <SelectTrigger id="timezone" className="min-h-11 w-full sm:w-72" aria-describedby="timezone-hint">
                    <SelectValue>{ZONE_NAMES[values.timezone] ?? values.timezone}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {VALID_US_TIMEZONES.map((zone) => (
                      <SelectItem key={zone} value={zone}>
                        {ZONE_NAMES[zone]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p id="timezone-hint" className="text-sm text-muted-foreground">
                  {timezoneConfirmed
                    ? "Your hours are read in this time zone."
                    : "We guessed this from your address. Check it and save to confirm it."}
                </p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Pickup and minimum order</CardTitle>
              <CardDescription>
                {storeDeliveryEnabled ? "Store delivery is on." : "Store delivery is off."} The platform team sets
                delivery for you.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="flex flex-col gap-1">
                <div className="flex min-h-11 items-center justify-between gap-4">
                  <label htmlFor="pickup" className="text-sm font-medium text-foreground">
                    Pickup in store
                  </label>
                  <Switch
                    id="pickup"
                    checked={values.pickupEnabled}
                    onCheckedChange={(pickupEnabled) => change({ pickupEnabled })}
                    aria-describedby="pickup-state"
                  />
                </div>
                <p id="pickup-state" className="text-sm text-muted-foreground">
                  {values.pickupEnabled ? "Shoppers can order ahead and collect at your store." : "Checkout does not offer pickup."}
                </p>
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="minimum">Minimum order</Label>
                <div className="flex items-center gap-2">
                  <span className="text-sm text-muted-foreground" aria-hidden="true">$</span>
                  <Input
                    id="minimum"
                    inputMode="decimal"
                    value={minimum}
                    onChange={(event) => {
                      setMinimum(event.target.value);
                      setNotice(null);
                    }}
                    aria-describedby="minimum-hint"
                    className="h-11 w-32"
                  />
                </div>
                <p id="minimum-hint" className="text-sm text-muted-foreground">
                  The smallest basket shoppers can check out, for pickup and delivery alike. 0 means no minimum.
                </p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Contact and about</CardTitle>
              <CardDescription>How shoppers and couriers get to know you.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor="phone">Store phone</Label>
                <Input
                  id="phone"
                  type="tel"
                  autoComplete="tel"
                  value={values.phone}
                  onChange={(event) => change({ phone: event.target.value })}
                  aria-describedby="phone-hint"
                  className="h-11 sm:w-72"
                  placeholder="(312) 555-0142"
                />
                <p id="phone-hint" className="text-sm text-muted-foreground">
                  A US number. Couriers call it when they collect an order.
                </p>
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="about">About the store</Label>
                <Textarea
                  id="about"
                  value={values.about}
                  onChange={(event) => change({ about: event.target.value })}
                  rows={4}
                  aria-describedby="about-hint"
                />
                <p id="about-hint" className="text-sm text-muted-foreground">
                  A few lines on who you are and what you sell. Your storefront shows it under &ldquo;Our story&rdquo;.{" "}
                  <span className="tabular-nums">{[...values.about].length}/{STORE_ABOUT_MAX}</span>
                </p>
              </div>
            </CardContent>
          </Card>

          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={pending} className="min-h-11 rounded-full px-6">
              {pending ? "Saving..." : "Save settings"}
            </Button>
            {notice ? (
              <p
                role={notice.ok ? "status" : "alert"}
                className={`flex items-center gap-1.5 text-sm ${notice.ok ? "text-muted-foreground" : "text-destructive"}`}
              >
                {notice.ok ? <Check className="size-4" aria-hidden="true" /> : <CircleAlert className="size-4" aria-hidden="true" />}
                {notice.text}
              </p>
            ) : null}
          </div>
        </form>
      </main>
    </div>
  );
}
