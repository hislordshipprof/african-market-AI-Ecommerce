"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Camera, CheckCircle2, Navigation, Snowflake, Truck } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { jpegBlob } from "@/lib/image/client-jpeg";
import { PHOTO_UPLOAD_MAX_BYTES } from "@/lib/listing/csv-file-cap";
import type { DriverStop } from "@/lib/delivery/driver-route";
import { driverDeliveredAction, driverOutForDeliveryAction } from "./actions";

const TRY_AGAIN = "That did not go through. Try again";

function Stop({ token, stop, index }: { token: string; stop: DriverStop; index: number }) {
  const router = useRouter();
  const [photo, setPhoto] = useState<File | null>(null);
  const [isPending, startTransition] = useTransition();
  const delivered = stop.status === "DELIVERED";
  const photoId = `photo-${stop.orderId}`;

  function finish(result: { ok: boolean; error?: string }, done: string) {
    if (!result.ok) {
      toast.error(result.error ?? TRY_AGAIN);
      router.refresh();
      return;
    }
    toast.success(done);
    setPhoto(null);
    router.refresh();
  }

  function outForDelivery() {
    startTransition(async () => {
      finish(await driverOutForDeliveryAction(token, stop.orderId).catch(() => ({ ok: false, error: TRY_AGAIN })), "Out for delivery");
    });
  }

  function markDelivered() {
    if (!photo) {
      toast.error("Add a photo of the delivered order");
      return;
    }
    startTransition(async () => {
      let jpeg: Blob;
      try {
        jpeg = await jpegBlob(photo, PHOTO_UPLOAD_MAX_BYTES);
      } catch {
        toast.error("This phone can't read that photo. Take it again");
        return;
      }
      const form = new FormData();
      form.set("token", token);
      form.set("orderId", stop.orderId);
      form.set("photo", new File([jpeg], "delivery.jpg", { type: "image/jpeg" }));
      finish(await driverDeliveredAction(form).catch(() => ({ ok: false, error: TRY_AGAIN })), "Delivered. The customer has been told");
    });
  }

  return (
    <li className={`rounded-xl border border-border bg-card p-4 ${delivered ? "opacity-70" : ""}`} aria-label={`Stop ${index + 1}`}>
      <div className="flex items-start gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-semibold" aria-hidden>
          {index + 1}
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-medium">{stop.address}</p>
          <p className="text-sm text-muted-foreground">
            {stop.customerName} · Order #{stop.number}
          </p>
          {(stop.frozen || stop.leaveAtDoor) && (
            <p className="mt-2 flex flex-wrap gap-2 text-sm">
              {stop.frozen && (
                <span className="inline-flex items-center gap-1 rounded-full border border-border px-2.5 py-0.5 font-semibold">
                  <Snowflake className="size-4" aria-hidden />
                  Frozen
                </span>
              )}
              {stop.leaveAtDoor && (
                <span className="inline-flex items-center rounded-full border border-border px-2.5 py-0.5">Leave at door</span>
              )}
            </p>
          )}
          {stop.notes && <p className="mt-2 rounded-lg bg-muted px-3 py-2 text-sm">{stop.notes}</p>}
        </div>
      </div>

      {delivered ? (
        <p className="mt-3 flex items-center gap-1.5 text-sm font-medium">
          <CheckCircle2 className="size-4" aria-hidden />
          Delivered
        </p>
      ) : (
        <div className="mt-4 grid gap-2">
          <a
            href={stop.mapsUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={buttonVariants({ variant: "outline", className: "min-h-11 rounded-full" })}
          >
            <Navigation className="size-4" aria-hidden />
            Navigate
          </a>
          {stop.status === "READY" && (
            <Button className="min-h-11 rounded-full" onClick={outForDelivery} disabled={isPending}>
              <Truck className="size-4" aria-hidden />
              Out for delivery
            </Button>
          )}
          {stop.status === "OUT_FOR_DELIVERY" && (
            <>
              <label
                htmlFor={photoId}
                className="flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-full border border-input px-4 text-sm font-medium"
              >
                <Camera className="size-4" aria-hidden />
                {photo ? "Photo added. Retake" : "Take delivery photo"}
              </label>
              <input
                id={photoId}
                type="file"
                accept="image/*"
                capture="environment"
                className="sr-only"
                onChange={(e) => setPhoto(e.target.files?.[0] ?? null)}
              />
              <Button className="min-h-11 rounded-full" onClick={markDelivered} disabled={isPending || !photo}>
                <CheckCircle2 className="size-4" aria-hidden />
                Delivered
              </Button>
            </>
          )}
        </div>
      )}
    </li>
  );
}

export function RouteStops({ token, stops }: { token: string; stops: DriverStop[] }) {
  return (
    <ol className="grid gap-3">
      {stops.map((stop, index) => <Stop key={stop.orderId} token={token} stop={stop} index={index} />)}
    </ol>
  );
}
