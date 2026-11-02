"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  ArrowLeft,
  Bell,
  BellOff,
  Check,
  CheckCircle2,
  Clock,
  HandMetal,
  Package,
  ShoppingBag,
} from "lucide-react";
import {
  fetchOrdersAction,
  acceptOrderAction,
  autoAcceptOrderAction,
  markLinePickedAction,
  completePickupAction,
} from "@/lib/order/actions";
import type { StoreOrderRow } from "@/lib/order/service";
import { sortPickListLines } from "@/lib/order/pick-sort";

const STATUS_CONFIG: Record<
  string,
  { label: string; variant: "default" | "secondary" | "destructive" | "outline"; icon: typeof Clock }
> = {
  AUTHORIZED: { label: "New", variant: "destructive", icon: Bell },
  ACCEPTED: { label: "Accepted", variant: "default", icon: Check },
  PICKING: { label: "Picking", variant: "secondary", icon: Package },
  READY: { label: "Ready", variant: "default", icon: CheckCircle2 },
  AWAITING_PICKUP: { label: "Awaiting pickup", variant: "outline", icon: ShoppingBag },
};

interface Props {
  initialOrders: StoreOrderRow[];
  storeName: string;
  storeSlug: string;
  autoAcceptOrders: boolean;
  defaultPrepMinutes: number;
}

export function OrderInbox({
  initialOrders,
  storeName,
  storeSlug,
  autoAcceptOrders,
  defaultPrepMinutes,
}: Props) {
  const searchParams = useSearchParams();
  const storeParam = searchParams.get("store") ?? storeSlug;
  const [orders, setOrders] = useState(initialOrders);
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [audioEnabled, setAudioEnabled] = useState(true);
  const [acceptDialogOpen, setAcceptDialogOpen] = useState(false);
  const [acceptingOrderId, setAcceptingOrderId] = useState<string | null>(null);
  const [prepMinutes, setPrepMinutes] = useState(String(defaultPrepMinutes));
  const prevOrderIdsRef = useRef(new Set(initialOrders.map((o) => o.id)));
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    if (typeof window !== "undefined") {
      audioRef.current = new Audio(
        "data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQoGAACBhYqFbF1fdJivrJBhNjVgodDbsGczHjqIr9zwupRBKkeMwO//xpxLM0eNwu//xZpJMkiOw+//xJlIMEqQxO//w5hHL0uRxe//wpZGLk2Txu//wZVFLU6Ux+//wJRELE+VyO//v5NDLVCW"
      );
      audioRef.current.volume = 0.5;
    }
  }, []);

  const pollOrders = useCallback(() => {
    startTransition(async () => {
      try {
        const { orders: fresh } = await fetchOrdersAction();
        const prevIds = prevOrderIdsRef.current;
        const newOrders = fresh.filter((o) => !prevIds.has(o.id));
        if (newOrders.length > 0 && audioEnabled && audioRef.current) {
          audioRef.current.play().catch(() => {});
        }
        if (autoAcceptOrders) {
          for (const o of newOrders) {
            if (o.status === "AUTHORIZED") {
              await autoAcceptOrderAction(o.id);
            }
          }
        }
        prevOrderIdsRef.current = new Set(fresh.map((o) => o.id));
        setOrders(fresh);
      } catch {
        // polling failure is non-fatal
      }
    });
  }, [audioEnabled, autoAcceptOrders]);

  useEffect(() => {
    const interval = setInterval(pollOrders, 10_000);
    return () => clearInterval(interval);
  }, [pollOrders]);

  const selectedOrder = orders.find((o) => o.id === selectedOrderId);

  function handleAcceptClick(orderId: string) {
    setAcceptingOrderId(orderId);
    setPrepMinutes(String(defaultPrepMinutes));
    setAcceptDialogOpen(true);
  }

  function handleAcceptConfirm() {
    if (!acceptingOrderId) return;
    const mins = parseInt(prepMinutes, 10);
    if (isNaN(mins) || mins < 1) {
      toast.error("Enter a valid prep time");
      return;
    }
    startTransition(async () => {
      const result = await acceptOrderAction(acceptingOrderId, mins);
      if (result.ok) {
        toast.success("Order accepted");
        setAcceptDialogOpen(false);
        pollOrders();
      } else {
        toast.error(result.error);
      }
    });
  }

  function handleMarkPicked(lineId: string) {
    startTransition(async () => {
      const result = await markLinePickedAction(lineId);
      if (result.ok) {
        toast.success("Line picked");
        pollOrders();
      } else {
        toast.error(result.error);
      }
    });
  }

  function handleCompletePickup(orderId: string) {
    startTransition(async () => {
      const result = await completePickupAction(orderId);
      if (result.ok) {
        toast.success("Pickup completed");
        setSelectedOrderId(null);
        pollOrders();
      } else {
        toast.error(result.error);
      }
    });
  }

  function formatCents(cents: number) {
    return `$${(cents / 100).toFixed(2)}`;
  }

  function lineProductName(line: StoreOrderRow["lines"][number]) {
    return (
      line.listingVariant.listing.customName ??
      line.listingVariant.listing.masterProduct?.name ??
      "Unknown product"
    );
  }

  const sortedPickLines = selectedOrder
    ? sortPickListLines(
        selectedOrder.lines.map((l) => ({
          ...l,
          frozen: l.listingVariant.listing.frozen,
          perishable: l.listingVariant.listing.perishable,
        })),
      )
    : [];

  return (
    <div className="min-h-dvh bg-background">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-4 py-3">
          <div className="flex items-center gap-3">
            <Link
              href={`/store-admin?store=${storeParam}`}
              className="flex size-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:text-foreground"
            >
              <ArrowLeft className="size-5" />
            </Link>
            <div>
              <h1 className="text-base font-semibold text-foreground">
                Orders
              </h1>
              <p className="text-xs text-muted-foreground">{storeName}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setAudioEnabled(!audioEnabled)}
              aria-label={audioEnabled ? "Mute alerts" : "Enable alerts"}
            >
              {audioEnabled ? (
                <Bell className="size-4" />
              ) : (
                <BellOff className="size-4" />
              )}
            </Button>
            <Badge variant="secondary">
              {orders.filter((o) => o.status === "AUTHORIZED").length} new
            </Badge>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-4 py-6">
        {selectedOrder ? (
          <div>
            <button
              onClick={() => setSelectedOrderId(null)}
              className="mb-4 flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
            >
              <ArrowLeft className="size-4" /> Back to orders
            </button>

            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="text-lg">
                    Order #{selectedOrder.number}
                  </CardTitle>
                  <Badge
                    variant={
                      STATUS_CONFIG[selectedOrder.status]?.variant ?? "outline"
                    }
                  >
                    {STATUS_CONFIG[selectedOrder.status]?.label ??
                      selectedOrder.status}
                  </Badge>
                </div>
                <div className="text-sm text-muted-foreground">
                  {selectedOrder.customer.name} &middot;{" "}
                  {selectedOrder.customer.phone}
                </div>
                {selectedOrder.notes && (
                  <p className="mt-1 text-sm italic text-muted-foreground">
                    {selectedOrder.notes}
                  </p>
                )}
              </CardHeader>
              <CardContent>
                {selectedOrder.status === "AUTHORIZED" && (
                  <Button
                    className="mb-4 w-full rounded-full"
                    onClick={() => handleAcceptClick(selectedOrder.id)}
                    disabled={isPending}
                  >
                    <Check className="mr-2 size-4" /> Accept order
                  </Button>
                )}

                {(selectedOrder.status === "ACCEPTED" ||
                  selectedOrder.status === "PICKING") && (
                  <div className="mb-4">
                    <h3 className="mb-2 text-sm font-semibold text-foreground">
                      Pick list
                    </h3>
                    <div className="space-y-2">
                      {sortedPickLines.map((line) => (
                        <div
                          key={line.id}
                          className={`flex items-center justify-between rounded-lg border p-3 ${
                            line.status === "picked"
                              ? "border-green-200 bg-green-50 dark:border-green-900 dark:bg-green-950"
                              : "border-border bg-card"
                          }`}
                        >
                          <div className="flex-1">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium text-foreground">
                                {lineProductName(line)}
                              </span>
                              {line.frozen && (
                                <Badge variant="secondary" className="text-xs">
                                  Frozen
                                </Badge>
                              )}
                              {line.perishable && (
                                <Badge variant="secondary" className="text-xs">
                                  Perishable
                                </Badge>
                              )}
                            </div>
                            <div className="text-xs text-muted-foreground">
                              {line.listingVariant.label} &middot; Qty:{" "}
                              {line.qtyOrdered}
                            </div>
                          </div>
                          {line.status === "picked" ? (
                            <CheckCircle2 className="size-5 text-green-600 dark:text-green-400" />
                          ) : (
                            <Button
                              variant="outline"
                              size="sm"
                              className="rounded-full"
                              onClick={() => handleMarkPicked(line.id)}
                              disabled={isPending}
                            >
                              Pick
                            </Button>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {selectedOrder.status === "AWAITING_PICKUP" && (
                  <Button
                    className="w-full rounded-full"
                    onClick={() => handleCompletePickup(selectedOrder.id)}
                    disabled={isPending}
                  >
                    <HandMetal className="mr-2 size-4" /> Hand off
                  </Button>
                )}

                <div className="mt-4 space-y-1 border-t pt-4">
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Subtotal</span>
                    <span>{formatCents(selectedOrder.subtotalCents)}</span>
                  </div>
                  {selectedOrder.tipCents > 0 && (
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">Tip</span>
                      <span>{formatCents(selectedOrder.tipCents)}</span>
                    </div>
                  )}
                  <div className="flex justify-between text-sm font-medium">
                    <span>Total</span>
                    <span>{formatCents(selectedOrder.totalCents || selectedOrder.subtotalCents)}</span>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        ) : (
          <div>
            {orders.length === 0 ? (
              <div className="py-12 text-center">
                <ShoppingBag className="mx-auto mb-3 size-10 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">
                  No active orders right now
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {orders.map((order) => {
                  const config = STATUS_CONFIG[order.status];
                  return (
                    <button
                      key={order.id}
                      onClick={() => setSelectedOrderId(order.id)}
                      className="w-full text-left"
                    >
                      <Card className="transition-shadow hover:shadow-md">
                        <CardContent className="flex items-center gap-4 p-4">
                          <div className="flex size-10 items-center justify-center rounded-lg bg-primary/10">
                            {config?.icon ? (
                              <config.icon className="size-5 text-primary" />
                            ) : (
                              <ShoppingBag className="size-5 text-primary" />
                            )}
                          </div>
                          <div className="flex-1">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-semibold text-foreground">
                                #{order.number}
                              </span>
                              <Badge
                                variant={config?.variant ?? "outline"}
                              >
                                {config?.label ?? order.status}
                              </Badge>
                            </div>
                            <div className="text-xs text-muted-foreground">
                              {order.customer.name} &middot;{" "}
                              {order.lines.length} item
                              {order.lines.length !== 1 ? "s" : ""} &middot;{" "}
                              {formatCents(order.totalCents || order.subtotalCents)}
                            </div>
                          </div>
                          <div className="flex items-center gap-1 text-xs text-muted-foreground">
                            <Clock className="size-3" />
                            {new Date(order.createdAt).toLocaleTimeString([], {
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </div>
                        </CardContent>
                      </Card>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </main>

      <Dialog open={acceptDialogOpen} onOpenChange={setAcceptDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Accept order</DialogTitle>
            <DialogDescription>
              Set the estimated prep time for this order.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Label htmlFor="prep-minutes">Prep time (minutes)</Label>
            <Input
              id="prep-minutes"
              type="number"
              min="1"
              max="120"
              value={prepMinutes}
              onChange={(e) => setPrepMinutes(e.target.value)}
              className="mt-1"
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setAcceptDialogOpen(false)}
              className="rounded-full"
            >
              Cancel
            </Button>
            <Button
              onClick={handleAcceptConfirm}
              disabled={isPending}
              className="rounded-full"
            >
              Accept
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
