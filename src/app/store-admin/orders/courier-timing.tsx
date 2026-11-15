"use client";

import { Clock, Truck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { courierLine, type StaffCourier } from "@/lib/order/staff-copy";

const time = (value: Date | string) => new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/**
 * A courier order's timing (#562): the ready time the courier is booked for, the store's one push while packing,
 * and where the courier is.
 */
export function CourierTiming(props: {
  status: string;
  readyEstimateAt: Date | string | null;
  readyPushedAt: Date | string | null;
  courier: StaffCourier | null;
  disabled: boolean;
  onPush: () => void;
}) {
  const packing = props.status === "PICKING" || props.status === "SUBSTITUTION_PENDING";
  const line = courierLine(props.courier, time);
  if (!props.readyEstimateAt && !line) return null;
  return (
    <div className="mb-4 rounded-xl border border-border bg-card p-3" aria-label="Courier timing">
      {props.readyEstimateAt && packing && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="flex items-center gap-1.5 text-sm font-medium text-foreground">
            <Clock className="size-4 text-muted-foreground" aria-hidden />
            Ready by {time(props.readyEstimateAt)}
          </p>
          {props.readyPushedAt ? (
            <span className="text-xs text-muted-foreground">Pushed once</span>
          ) : (
            <Button variant="outline" className="min-h-11 rounded-full" onClick={props.onPush} disabled={props.disabled}>
              5 more minutes
            </Button>
          )}
        </div>
      )}
      {line && (
        <p className={`flex items-center gap-1.5 text-sm text-muted-foreground ${props.readyEstimateAt && packing ? "mt-2" : ""}`}>
          <Truck className="size-4" aria-hidden />
          {line}
        </p>
      )}
    </div>
  );
}
