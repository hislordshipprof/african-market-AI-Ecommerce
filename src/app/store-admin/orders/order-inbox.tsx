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
  RefreshCw,
  ShoppingBag,
  UserCheck,
} from "lucide-react";
import {
  fetchOrdersAction,
  acceptOrderAction,
  autoAcceptOrderAction,
  markLinePickedAction,
  markReadyAction,
  completePickupAction,
} from "@/lib/order/actions";
import type { StoreOrderRow } from "@/lib/order/service";
import { RESOLVED_LINE_STATUSES } from "@/lib/order/constants";
import { sortPickListLines } from "@/lib/order/pick-sort";
import { money } from "@/lib/format";
import { REFUND_FAILED_STAFF_COPY, showCapturedLine } from "@/lib/order/staff-copy";

const STATUS_CONFIG: Record<
  string,
  { label: string; variant: "default" | "secondary" | "destructive" | "outline"; icon: typeof Clock }
> = {
  AUTHORIZED: { label: "New", variant: "destructive", icon: Bell },
  ACCEPTED: { label: "Accepted", variant: "default", icon: Check },
  PICKING: { label: "Picking", variant: "secondary", icon: Package },
  CAPTURING: { label: "Capturing…", variant: "secondary", icon: RefreshCw },
  CANCELLING: { label: "Cancelling…", variant: "destructive", icon: RefreshCw },
  READY: { label: "Ready", variant: "default", icon: CheckCircle2 },
  AWAITING_PICKUP: { label: "Awaiting pickup", variant: "outline", icon: ShoppingBag },
  REFUND_FAILED: { label: "Refund failed", variant: "destructive", icon: Bell },
  CANCELLED: { label: "Cancelled", variant: "outline", icon: CheckCircle2 },
};

function orderCustomerLabel(name: string, phone: string | null): string {
  const trimmed = phone?.trim() ?? "";
  if (!trimmed) return name;
  return `${name} · ${trimmed}`;
}

/** Not a status, so it does not look like one. */
function AccountBadge() {
  return (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground">
      <UserCheck className="size-3" aria-hidden="true" />
      <span className="sr-only">Linked to a customer </span>
      Account
    </span>
  );
}

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
      const ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
      const buf = ctx.createBuffer(1, ctx.sampleRate / 4, ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < data.length; i++) {
        data[i] = Math.sin(2 * Math.PI * 880 * (i / ctx.sampleRate)) * Math.exp(-3 * (i / data.length));
      }
      audioRef.current = { ctx, buf } as unknown as HTMLAudioElement;
    }
  }, []);

  useEffect(() => {
    if (!autoAcceptOrders) return;
    for (const o of initialOrders) {
      if (o.status === "AUTHORIZED") {
        autoAcceptOrderAction(o.id).catch(() => {});
      }
    }
  }, [autoAcceptOrders, initialOrders]);

  const pollOrders = useCallback(() => {
    startTransition(async () => {
      try {
        const { orders: fresh } = await fetchOrdersAction();
        const prevIds = prevOrderIdsRef.current;
        const newOrders = fresh.filter((o) => !prevIds.has(o.id));
        if (newOrders.length > 0 && audioEnabled && audioRef.current) {
          const audio = audioRef.current as unknown as { ctx: AudioContext; buf: AudioBuffer };
          const src = audio.ctx.createBufferSource();
          src.buffer = audio.buf;
          src.connect(audio.ctx.destination);
          src.start();
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
  const allLinesResolved =
    selectedOrder?.status === "PICKING"
      ? selectedOrder.lines.every((l) =>
          RESOLVED_LINE_STATUSES.includes(l.status as "picked" | "refunded" | "substituted"),
        )
      : false;

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

  function handleMarkReady(orderId: string) {
    startTransition(async () => {
      const result = await markReadyAction(orderId);
      if (result.ok) {
        if (result.voided) {
          toast.success("Order cancelled — amount below capture minimum");
        } else {
          toast.success("Order marked ready");
        }
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
      <header className="sticky top-0 z-10 border-b border-border bg-card/95 backdrop-blur-sm">
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
              className="mb-4 flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              <ArrowLeft className="size-4" /> Back to orders
            </button>

            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="text-lg font-bold tabular-nums">
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
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
                  <span>
                    {orderCustomerLabel(
                      selectedOrder.customer.name,
                      selectedOrder.customer.phone,
                    )}
                  </span>
                  {selectedOrder.hasAccount && <AccountBadge />}
                </div>
                {selectedOrder.notes && (
                  <p className="mt-1 whitespace-pre-line text-sm italic text-muted-foreground">
                    {selectedOrder.notes}
                  </p>
                )}
                {selectedOrder.fulfillment === "store-delivery" && selectedOrder.deliveryLine1 && (
                  <p className="mt-2 text-sm text-foreground">
                    {selectedOrder.deliveryLine1}
                    {selectedOrder.deliveryLine2 ? `, ${selectedOrder.deliveryLine2}` : ""}
                    {", "}
                    {selectedOrder.deliveryCity}, {selectedOrder.deliveryState} {selectedOrder.deliveryZip}
                    {selectedOrder.leaveAtDoor ? " · Leave at door" : ""}
                  </p>
                )}
                {selectedOrder.status === "REFUND_FAILED" && (
                  <p className="mt-2 text-sm text-destructive">
                    {REFUND_FAILED_STAFF_COPY}
                  </p>
                )}
                {selectedOrder.status === "CANCELLED" && selectedOrder.notes ? (
                  <p className="mt-2 text-sm text-foreground">The platform resolved this refund.</p>
                ) : null}
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
                          className={`flex items-center justify-between rounded-xl border p-3 transition-colors ${
                            line.status === "picked"
                              ? "border-green-200 bg-green-50 dark:border-green-900 dark:bg-green-950"
                              : "border-border bg-card"
                          }`}
                        >
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="text-sm font-medium text-foreground">
                                {lineProductName(line)}
                              </span>
                              {line.frozen && (
                                <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
                                  Frozen
                                </Badge>
                              )}
                              {line.perishable && (
                                <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
                                  Perishable
                                </Badge>
                              )}
                            </div>
                            <div className="mt-0.5 text-xs text-muted-foreground">
                              {line.listingVariant.label} &middot; Qty:{" "}
                              {line.qtyOrdered}
                            </div>
                          </div>
                          {line.status === "picked" ? (
                            <CheckCircle2 className="size-5 shrink-0 text-green-600 dark:text-green-400" />
                          ) : (
                            <Button
                              variant="outline"
                              size="sm"
                              className="shrink-0 rounded-full"
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

                {selectedOrder.status === "PICKING" && (
                  <Button
                    className="mb-4 w-full rounded-full"
                    onClick={() => handleMarkReady(selectedOrder.id)}
                    disabled={isPending || !allLinesResolved}
                  >
                    <CheckCircle2 className="mr-2 size-4" /> Mark ready
                  </Button>
                )}

                {selectedOrder.status === "CAPTURING" && (
                  <Button
                    className="mb-4 w-full rounded-full"
                    variant="outline"
                    onClick={() => handleMarkReady(selectedOrder.id)}
                    disabled={isPending}
                  >
                    <RefreshCw className="mr-2 size-4" /> Retry capture
                  </Button>
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

                <div className="mt-6 space-y-1.5 border-t pt-4">
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Subtotal</span>
                    <span className="tabular-nums">{money(selectedOrder.subtotalCents)}</span>
                  </div>
                  {selectedOrder.tipCents > 0 && (
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">Tip</span>
                      <span className="tabular-nums">{money(selectedOrder.tipCents)}</span>
                    </div>
                  )}
                  <div className="flex justify-between pt-1.5 text-base font-semibold">
                    <span>Total</span>
                    <span className="tabular-nums" data-testid="order-total">
                      {money(selectedOrder.totalCents ?? selectedOrder.subtotalCents)}
                    </span>
                  </div>
                  {(() => {
                    const captured = selectedOrder.capturedAmountCents;
                    if (captured == null || !showCapturedLine(selectedOrder.status, captured)) return null;
                    return (
                      <div className="flex justify-between text-sm">
                        <span className="text-muted-foreground">Captured</span>
                        <span className="tabular-nums" data-testid="order-captured">
                          {money(captured)}
                        </span>
                      </div>
                    );
                  })()}
                </div>
              </CardContent>
            </Card>
          </div>
        ) : (
          <div>
            {orders.length === 0 ? (
              <div className="py-20 text-center">
                <ShoppingBag className="mx-auto mb-4 size-12 text-muted-foreground/50" />
                <p className="text-sm font-medium text-muted-foreground">
                  No active orders right now
                </p>
                <p className="mt-1 text-xs text-muted-foreground/70">
                  New orders will appear here automatically
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
                      <Card className="transition-all duration-200 hover:shadow-md active:scale-[0.99]">
                        <CardContent className="flex items-center gap-4 px-4 py-3.5">
                          <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary/10">
                            {config?.icon ? (
                              <config.icon className="size-5 text-primary" />
                            ) : (
                              <ShoppingBag className="size-5 text-primary" />
                            )}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                              <span className="text-sm font-bold tabular-nums text-foreground">
                                #{order.number}
                              </span>
                              <Badge
                                variant={config?.variant ?? "outline"}
                              >
                                {config?.label ?? order.status}
                              </Badge>
                              {order.hasAccount && <AccountBadge />}
                            </div>
                            <div className="mt-0.5 flex items-baseline gap-1 text-xs text-muted-foreground">
                              <span className="min-w-0 truncate">
                                {order.customer.name}
                              </span>
                              <span className="shrink-0 whitespace-nowrap tabular-nums">
                                &middot; {order.lines.length} item{order.lines.length !== 1 ? "s" : ""} &middot; {money(order.totalCents ?? order.subtotalCents)}
                              </span>
                            </div>
                          </div>
                          <div className="flex shrink-0 items-center gap-1 text-xs tabular-nums text-muted-foreground">
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
