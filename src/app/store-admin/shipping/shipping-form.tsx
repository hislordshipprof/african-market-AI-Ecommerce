"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ArrowLeft, Check, CircleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { updateStoreShipping } from "@/lib/store-admin/shipping-actions";

const HANDLING_DAYS = Array.from({ length: 10 }, (_, i) => i + 1);
const DEFAULT_HANDLING_DAYS = 2;

interface Props {
  storeName: string;
  storeSlug: string;
  /** Null: the store does not ship (#567). */
  initialHandlingDays: number | null;
  /** States the platform has opened for shipping (ADR-0023). */
  states: string[];
  shippableListings: number;
  located: boolean;
}

function days(count: number) {
  return `${count} business ${count === 1 ? "day" : "days"}`;
}

export function ShippingForm({ storeName, storeSlug, initialHandlingDays, states, shippableListings, located }: Props) {
  const searchParams = useSearchParams();
  const storeParam = searchParams.get("store") ?? storeSlug;
  const [ships, setShips] = useState(initialHandlingDays !== null);
  const [handlingDays, setHandlingDays] = useState(initialHandlingDays ?? DEFAULT_HANDLING_DAYS);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  // Says what shoppers can do now, not only that the form saved.
  function savedText() {
    if (!ships) return "Saved. Your store no longer ships.";
    if (!located) return "Saved. Shipping starts once your store address is confirmed.";
    if (shippableListings === 0) return "Saved. Mark items to ship on Listings before shoppers can choose Ship.";
    return "Saved. Checkout offers Ship now.";
  }

  function save(event: React.FormEvent) {
    event.preventDefault();
    startTransition(async () => {
      const result = await updateStoreShipping({ handlingDays: ships ? handlingDays : null });
      setNotice(result.ok ? { ok: true, text: savedText() } : { ok: false, text: result.message });
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
            <h1 className="text-base font-semibold text-foreground">Shipping</h1>
            <p className="text-xs text-muted-foreground">{storeName}</p>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-2xl px-4 py-6">
        <form onSubmit={save} className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Ship dry goods by parcel</CardTitle>
              <CardDescription>
                Shoppers far from your store can order shelf-stable items by parcel. They pay the carrier&rsquo;s own
                rate, with no markup.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="flex flex-col gap-1">
                <div className="flex min-h-11 items-center justify-between gap-4">
                  <label htmlFor="ships" className="text-sm font-medium text-foreground">
                    Ship orders
                  </label>
                  <Switch
                    id="ships"
                    checked={ships}
                    onCheckedChange={(checked) => {
                      setShips(checked);
                      setNotice(null);
                    }}
                    aria-describedby="ships-state"
                  />
                </div>
                <p id="ships-state" className="text-sm text-muted-foreground">
                  {ships
                    ? "Checkout offers Ship when every item in the basket can ship."
                    : "Checkout offers pickup and delivery only."}
                </p>
              </div>

              {ships && (
                <div className="flex flex-col gap-2">
                  <Label htmlFor="handling-days">Handling time</Label>
                  <Select
                    value={String(handlingDays)}
                    onValueChange={(value) => {
                      if (!value) return;
                      setHandlingDays(Number(value));
                      setNotice(null);
                    }}
                  >
                    <SelectTrigger id="handling-days" className="min-h-11 w-full sm:w-56" aria-describedby="handling-hint">
                      <SelectValue>{days(handlingDays)}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {HANDLING_DAYS.map((count) => (
                        <SelectItem key={count} value={String(count)}>
                          {days(count)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p id="handling-hint" className="text-sm text-muted-foreground">
                    How long you need to pack a parcel and hand it to the carrier. Shoppers see it in the arrival
                    estimate.
                  </p>
                </div>
              )}

              {ships && !located ? (
                <p role="note" className="flex items-start gap-2 rounded-lg bg-muted px-3 py-2 text-sm text-foreground">
                  <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                  Shipping starts once the platform team confirms your store address. Ask them if it is missing.
                </p>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">What ships</CardTitle>
              <CardDescription>Checkout checks each of these before it shows a rate.</CardDescription>
            </CardHeader>
            <CardContent>
              <ul role="list" className="flex flex-col divide-y divide-border text-sm">
                <li className="flex flex-wrap items-center justify-between gap-x-4 pb-1">
                  <span className="text-foreground">
                    <span className="font-semibold tabular-nums">{shippableListings}</span>{" "}
                    {shippableListings === 1 ? "listing ships" : "listings ship"} nationwide
                  </span>
                  <Link href={`/store-admin/listings?store=${storeParam}`} className="inline-flex min-h-11 items-center font-medium text-primary underline-offset-4 hover:underline">
                    Choose on Listings
                  </Link>
                </li>
                <li className="py-3 text-muted-foreground">
                  Dry goods only: not frozen, not perishable, and every size has a real weight.
                </li>
                <li className="py-3 text-muted-foreground">Up to 50 lb per order, in one parcel.</li>
                <li className="py-3 text-muted-foreground last:pb-0">
                  {states.length > 0
                    ? `Ships to ${states.join(", ")}. The platform team opens more states once tax is set up for them.`
                    : "No states are open for shipping yet. The platform team opens states once tax is set up for them."}
                </li>
              </ul>
            </CardContent>
          </Card>

          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={pending} className="min-h-11 rounded-full px-6">
              {pending ? "Saving..." : "Save shipping"}
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
