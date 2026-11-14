"use client";

import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { Route, Send, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { STAFF_GENERIC_ERROR } from "@/lib/order/staff-copy";
import { assignDriverRouteAction, driverRouteBoardAction, revokeDriverRouteAction } from "@/lib/delivery/driver-route-actions";
import type { DriverRouteSlot } from "@/lib/delivery/driver-route";

const deliveries = (n: number) => (n === 1 ? "1 delivery" : `${n} deliveries`);

function SlotRow({ slot, onChange }: { slot: DriverRouteSlot; onChange: () => void }) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [isPending, startTransition] = useTransition();
  const id = `route-${slot.slot}`;

  function run(action: () => Promise<{ ok: boolean; error?: string }>, done: string) {
    startTransition(async () => {
      let result: { ok: boolean; error?: string };
      try {
        result = await action();
      } catch {
        result = { ok: false, error: STAFF_GENERIC_ERROR };
      }
      if (!result.ok) {
        toast.error(result.error ?? STAFF_GENERIC_ERROR);
        return;
      }
      toast.success(done);
      setName("");
      setPhone("");
      onChange();
    });
  }

  return (
    <li className="border-t border-border py-4 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-medium text-foreground">{slot.label}</p>
        <p className="text-sm text-muted-foreground">
          {slot.waiting > 0 ? `${deliveries(slot.waiting)} waiting for a driver` : "All assigned"}
        </p>
      </div>

      {slot.routes.length > 0 && (
        <ul className="mt-3 space-y-2">
          {slot.routes.map((route) => (
            <li key={route.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-muted/50 px-3 py-2">
              <span className="flex items-center gap-2 text-sm text-foreground">
                <Route className="size-4 text-muted-foreground" aria-hidden />
                {route.driverName} · phone ending {route.phoneLast4} · {deliveries(route.orders)}
              </span>
              <Button
                variant="outline"
                className="min-h-11 rounded-full"
                disabled={isPending}
                onClick={() => run(() => revokeDriverRouteAction(route.id), `${route.driverName}'s link no longer works`)}
              >
                <X className="size-4" aria-hidden />
                Revoke link
              </Button>
            </li>
          ))}
        </ul>
      )}

      {slot.waiting > 0 && (
        <form
          className="mt-3 grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
          onSubmit={(event) => {
            event.preventDefault();
            run(
              () => assignDriverRouteAction({ slot: slot.slot, driverName: name, driverPhone: phone }),
              `Route texted to ${name.trim()}`,
            );
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-name`}>Driver name</Label>
            <Input id={`${id}-name`} value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" required maxLength={80} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-phone`}>Driver mobile</Label>
            <Input
              id={`${id}-phone`}
              type="tel"
              inputMode="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              autoComplete="off"
              placeholder="(713) 555-0123"
              required
            />
          </div>
          <Button type="submit" className="min-h-11 rounded-full" disabled={isPending}>
            <Send className="size-4" aria-hidden />
            Text route link
          </Button>
        </form>
      )}
    </li>
  );
}

/** Own-driver routes (#566): text one slot's Ready store-delivery orders to a driver, or revoke the link. */
export function DriverRoutes({ initialSlots }: { initialSlots: DriverRouteSlot[] }) {
  const [slots, setSlots] = useState(initialSlots);
  const refresh = () => {
    driverRouteBoardAction().then(setSlots).catch(() => {});
  };
  // Orders turn Ready in the inbox beside this panel; the same 10s poll keeps the slots current.
  useEffect(() => {
    const interval = setInterval(refresh, 10_000);
    return () => clearInterval(interval);
  }, []);
  if (slots.length === 0) return null;
  return (
    <Card className="mb-6" aria-labelledby="driver-routes-title">
      <CardHeader>
        <CardTitle id="driver-routes-title" className="text-lg">Your driver&rsquo;s route</CardTitle>
        <p className="text-sm text-muted-foreground">
          Text a driver one slot&rsquo;s Ready orders. The link shows the stops in order and works until midnight.
        </p>
      </CardHeader>
      <CardContent>
        <ul>
          {slots.map((slot) => <SlotRow key={slot.slot} slot={slot} onChange={refresh} />)}
        </ul>
      </CardContent>
    </Card>
  );
}
