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
import { Textarea } from "@/components/ui/textarea";
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
  Truck,
  ShoppingBag,
  UserCheck,
  XCircle,
} from "lucide-react";
import {
  fetchOrdersAction,
  acceptOrderAction,
  autoAcceptOrderAction,
  markLinePickedAction,
  markLineShortAction,
  markReadyAction,
  completePickupAction,
  markOutForDeliveryAction,
  markDeliveredAction,
  cancelOrderAction,
} from "@/lib/order/actions";
import type { StoreOrderRow } from "@/lib/order/service";
import { CANCELLABLE_BEFORE_CAPTURE, RESOLVED_LINE_STATUSES, type StoreCancelReason } from "@/lib/order/constants";
import { sortPickListLines } from "@/lib/order/pick-sort";
import { money } from "@/lib/format";
import { jpegBlob } from "@/lib/image/client-jpeg";
import { PHOTO_UPLOAD_MAX_BYTES } from "@/lib/listing/csv-file-cap";
import { REFUND_FAILED_STAFF_COPY, STAFF_GENERIC_ERROR, showCapturedLine } from "@/lib/order/staff-copy";
import { captureSplit, courierFeeCents } from "@/lib/order/platform-fee";
import { OrderAlertsToggle } from "./order-alerts-toggle";

const STATUS_CONFIG: Record<
  string,
  { label: string; variant: "default" | "secondary" | "destructive" | "outline"; icon: typeof Clock }
> = {
  AUTHORIZED: { label: "New", variant: "destructive", icon: Bell },
  ACCEPTED: { label: "Accepted", variant: "default", icon: Check },
  PICKING: { label: "Picking", variant: "secondary", icon: Package },
  SUBSTITUTION_PENDING: { label: "Waiting on customer", variant: "secondary", icon: Clock },
  CAPTURING: { label: "Capturing…", variant: "secondary", icon: RefreshCw },
  CANCELLING: { label: "Cancelling…", variant: "destructive", icon: RefreshCw },
  READY: { label: "Ready", variant: "default", icon: CheckCircle2 },
  AWAITING_PICKUP: { label: "Awaiting pickup", variant: "outline", icon: ShoppingBag },
  OUT_FOR_DELIVERY: { label: "Out for delivery", variant: "secondary", icon: Truck },
  DELIVERED: { label: "Delivered", variant: "outline", icon: CheckCircle2 },
  REFUND_FAILED: { label: "Refund failed", variant: "destructive", icon: Bell },
  PARTIALLY_REFUNDED: { label: "Partly refunded", variant: "outline", icon: RefreshCw },
  REFUNDED: { label: "Refunded", variant: "outline", icon: CheckCircle2 },
  CANCELLED: { label: "Cancelled", variant: "outline", icon: CheckCircle2 },
};

const STORE_CANCEL_REASON_LABELS: Record<StoreCancelReason, string> = {
  out_of_stock: "Out of stock",
  store_closed: "Store closed",
  too_busy: "Too busy",
  other: "Other",
};

const STORE_CANCELLABLE: readonly string[] = CANCELLABLE_BEFORE_CAPTURE;

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
  vapidPublicKey: string | null;
  autoAcceptOrders: boolean;
  defaultPrepMinutes: number;
  problems?: React.ReactNode;
}

export function OrderInbox({
  initialOrders,
  storeName,
  storeSlug,
  vapidPublicKey,
  autoAcceptOrders,
  defaultPrepMinutes,
  problems,
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
  const [proofPhoto, setProofPhoto] = useState<{ orderId: string; file: File } | null>(null);
  const [cancellingOrderId, setCancellingOrderId] = useState<string | null>(null);
  const [shortLine, setShortLine] = useState<{ id: string; name: string; qtyOrdered: number } | null>(null);
  const [qtyFound, setQtyFound] = useState("0");
  const [cancelReason, setCancelReason] = useState<StoreCancelReason | null>(null);
  const [cancelNote, setCancelNote] = useState("");
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

  /** Every selection change drops the picked photo, so it can never ride along to another visit. */
  function selectOrder(orderId: string | null) {
    setProofPhoto(null);
    setSelectedOrderId(orderId);
  }
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

  function handleCancelClick(orderId: string) {
    setCancellingOrderId(orderId);
    setCancelReason(null);
    setCancelNote("");
  }

  function handleCancelConfirm() {
    if (!cancellingOrderId || !cancelReason) return;
    startTransition(async () => {
      const result = await cancelOrderAction(cancellingOrderId, { reason: cancelReason, note: cancelNote });
      if (result.ok) {
        toast.success("Order cancelled");
        setCancellingOrderId(null);
        pollOrders();
      } else {
        toast.error(result.error);
      }
    });
  }

  function handleShortConfirm() {
    if (!shortLine) return;
    const found = Number(qtyFound);
    if (!Number.isInteger(found) || found < 0 || found >= shortLine.qtyOrdered) {
      toast.error(`Enter a whole number from 0 to ${shortLine.qtyOrdered - 1}`);
      return;
    }
    startTransition(async () => {
      const result = await markLineShortAction(shortLine.id, found);
      if (result.ok) {
        toast.success("Customer asked to choose a swap or refund");
        setShortLine(null);
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
        selectOrder(null);
        pollOrders();
      } else {
        toast.error(result.error);
      }
    });
  }

  function handleOutForDelivery(orderId: string) {
    startTransition(async () => {
      let result: Awaited<ReturnType<typeof markOutForDeliveryAction>>;
      try {
        result = await markOutForDeliveryAction(orderId);
      } catch {
        toast.error(STAFF_GENERIC_ERROR);
        return;
      }
      if (result.ok) {
        toast.success("Out for delivery");
        pollOrders();
      } else {
        toast.error(result.error);
      }
    });
  }

  function handleMarkDelivered(orderId: string) {
    const photo = proofPhoto?.orderId === orderId ? proofPhoto.file : null;
    if (!photo) {
      toast.error("Add a photo of the delivered order");
      return;
    }
    startTransition(async () => {
      let jpeg: Blob;
      try {
        jpeg = await jpegBlob(photo, PHOTO_UPLOAD_MAX_BYTES);
      } catch {
        toast.error("This browser can't read that photo. Take it again or choose another one");
        return;
      }
      if (jpeg.size > PHOTO_UPLOAD_MAX_BYTES) {
        toast.error("The delivery photo is too large. Take it again or choose a smaller one");
        return;
      }
      const form = new FormData();
      form.set("orderId", orderId);
      form.set("photo", new File([jpeg], "delivery.jpg", { type: "image/jpeg" }));
      let result: Awaited<ReturnType<typeof markDeliveredAction>>;
      try {
        result = await markDeliveredAction(form);
      } catch {
        toast.error(STAFF_GENERIC_ERROR);
        return;
      }
      if (result.ok) {
        toast.success("Order delivered");
        selectOrder(null);
        pollOrders();
      } else {
        toast.error(result.error);
      }
    });
  }

  /** What the customer's answer or the timer did with a short line; the 10 s poll keeps it current. */
  function substitutionNote(line: StoreOrderRow["lines"][number]): string | null {
    const request = line.substitutionRequest;
    if (!request) return null;
    const missing = line.qtyOrdered - line.qtyPicked;
    if (request.status === "pending") {
      const due = new Date(request.expiresAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      const offer = request.proposedVariant ? `swap offered: ${variantName(request.proposedVariant)}` : "refund only";
      return `Found ${line.qtyPicked} of ${line.qtyOrdered} · waiting for customer (${offer}) · rule applies at ${due}`;
    }
    const by = request.status === "timed_out" ? " (timed out, rule applied)" : "";
    if (line.status === "substituted" && line.substitutedVariant) {
      return `Found ${line.qtyPicked} of ${line.qtyOrdered} · swap ${missing} for ${variantName(line.substitutedVariant)}${by}`;
    }
    return `Found ${line.qtyPicked} of ${line.qtyOrdered} · ${missing} refunded${by}`;
  }

  function variantName(variant: { label: string; listing: { customName: string | null; masterProduct: { name: string } | null } }) {
    return variant.listing.customName ?? variant.listing.masterProduct?.name ?? variant.label;
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
        <div className="mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-x-3 gap-y-2 px-4 py-3">
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
          <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
            <OrderAlertsToggle publicKey={vapidPublicKey} />
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
              onClick={() => selectOrder(null)}
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
                  selectedOrder.status === "PICKING" ||
                  selectedOrder.status === "SUBSTITUTION_PENDING") && (
                  <div className="mb-4">
                    <h3 className="mb-2 text-sm font-semibold text-foreground">
                      Pick list
                    </h3>
                    <div className="space-y-2">
                      {sortedPickLines.map((line) => (
                        <div
                          key={line.id}
                          className={`flex items-center justify-between rounded-xl border p-3 transition-colors ${
                            line.status !== "pending" && line.status !== "short"
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
                            {substitutionNote(line) && (
                              <div className="mt-1 text-xs font-medium text-foreground" role="status">
                                {substitutionNote(line)}
                              </div>
                            )}
                          </div>
                          {line.status === "pending" ? (
                            <div className="flex shrink-0 gap-2">
                              <Button
                                variant="ghost"
                                size="sm"
                                className="rounded-full"
                                onClick={() => {
                                  setQtyFound("0");
                                  setShortLine({ id: line.id, name: lineProductName(line), qtyOrdered: line.qtyOrdered });
                                }}
                                disabled={isPending}
                              >
                                Short
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                className="rounded-full"
                                onClick={() => handleMarkPicked(line.id)}
                                disabled={isPending}
                              >
                                Pick
                              </Button>
                            </div>
                          ) : line.status === "short" ? (
                            <Clock className="size-5 shrink-0 text-muted-foreground" aria-label="Waiting for customer" />
                          ) : (
                            <CheckCircle2 className="size-5 shrink-0 text-green-600 dark:text-green-400" />
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

                {STORE_CANCELLABLE.includes(selectedOrder.status) && (
                  <Button
                    className="mb-4 w-full rounded-full"
                    variant="destructive"
                    onClick={() => handleCancelClick(selectedOrder.id)}
                    disabled={isPending}
                  >
                    <XCircle className="mr-2 size-4" /> Cancel order
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

                {selectedOrder.status === "READY" && selectedOrder.fulfillment === "store-delivery" && (
                  <Button
                    className="w-full rounded-full"
                    onClick={() => handleOutForDelivery(selectedOrder.id)}
                    disabled={isPending}
                  >
                    <Truck className="mr-2 size-4" /> Out for delivery
                  </Button>
                )}

                {selectedOrder.status === "OUT_FOR_DELIVERY" && (
                  <div className="space-y-3">
                    <div className="space-y-1.5">
                      <Label htmlFor="delivery-proof">Delivery photo</Label>
                      <Input
                        key={selectedOrder.id}
                        id="delivery-proof"
                        type="file"
                        accept="image/jpeg,image/png,image/webp"
                        capture="environment"
                        onChange={(event) => {
                          const file = event.target.files?.[0];
                          setProofPhoto(file ? { orderId: selectedOrder.id, file } : null);
                        }}
                      />
                    </div>
                    <Button
                      className="w-full rounded-full"
                      onClick={() => handleMarkDelivered(selectedOrder.id)}
                      disabled={isPending || proofPhoto?.orderId !== selectedOrder.id}
                    >
                      <CheckCircle2 className="mr-2 size-4" /> Mark delivered
                    </Button>
                  </div>
                )}

                <div className="mt-6 space-y-1.5 border-t pt-4">
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Subtotal</span>
                    <span className="tabular-nums">{money(selectedOrder.subtotalCents)}</span>
                  </div>
                  {selectedOrder.serviceFeeCents > 0 && (
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">Service fee (platform)</span>
                      <span className="tabular-nums">{money(selectedOrder.serviceFeeCents)}</span>
                    </div>
                  )}
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
                    const split = captureSplit({
                      capturedCents: captured,
                      serviceFeeCents: selectedOrder.serviceFeeCents,
                      courierFeeCents: courierFeeCents(selectedOrder),
                    });
                    return (
                      <>
                        <div className="flex justify-between text-sm">
                          <span className="text-muted-foreground">Captured</span>
                          <span className="tabular-nums" data-testid="order-captured">
                            {money(captured)}
                          </span>
                        </div>
                        <div className="flex justify-between text-sm">
                          <span className="text-muted-foreground">Card fee on your part (2.9% + 30¢)</span>
                          <span className="tabular-nums">−{money(split.storeCardFeeCents)}</span>
                        </div>
                        <div className="flex justify-between text-sm font-medium">
                          <span>Your payout</span>
                          <span className="tabular-nums" data-testid="order-payout">
                            {money(split.storeReceivesCents)}
                          </span>
                        </div>
                      </>
                    );
                  })()}
                </div>
              </CardContent>
            </Card>
          </div>
        ) : (
          <div>
            {problems}
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
                      onClick={() => selectOrder(order.id)}
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

      <Dialog open={shortLine !== null} onOpenChange={(open) => !open && setShortLine(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Item short</DialogTitle>
            <DialogDescription>
              How many of {shortLine?.qtyOrdered} × {shortLine?.name} did you find? The customer gets 10 minutes to choose a swap or a refund for the rest.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Label htmlFor="qty-found">Quantity found</Label>
            <Input
              id="qty-found"
              type="number"
              inputMode="numeric"
              min="0"
              max={shortLine ? shortLine.qtyOrdered - 1 : undefined}
              value={qtyFound}
              onChange={(e) => setQtyFound(e.target.value)}
              className="mt-1"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShortLine(null)} className="rounded-full">
              Cancel
            </Button>
            <Button onClick={handleShortConfirm} disabled={isPending} className="rounded-full">
              Ask customer
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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

      <Dialog
        open={cancellingOrderId !== null}
        onOpenChange={(open) => {
          if (!open) setCancellingOrderId(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancel order</DialogTitle>
            <DialogDescription>
              The customer is told and the card hold is released. Put any picked items back on the shelf.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-4">
            <Label id="cancel-reason-label">Reason</Label>
            <div role="group" aria-labelledby="cancel-reason-label" className="grid grid-cols-2 gap-2">
              {(Object.keys(STORE_CANCEL_REASON_LABELS) as StoreCancelReason[]).map((reason) => (
                <Button
                  key={reason}
                  type="button"
                  variant={cancelReason === reason ? "default" : "outline"}
                  aria-pressed={cancelReason === reason}
                  className="rounded-full"
                  onClick={() => setCancelReason(reason)}
                >
                  {STORE_CANCEL_REASON_LABELS[reason]}
                </Button>
              ))}
            </div>
            <Label htmlFor="cancel-note">Note (optional)</Label>
            <Textarea
              id="cancel-note"
              maxLength={500}
              value={cancelNote}
              onChange={(e) => setCancelNote(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setCancellingOrderId(null)}
              className="rounded-full"
            >
              Keep order
            </Button>
            <Button
              variant="destructive"
              onClick={handleCancelConfirm}
              disabled={isPending || !cancelReason}
              className="rounded-full"
            >
              Cancel order
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
