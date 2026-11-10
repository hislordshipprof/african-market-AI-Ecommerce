"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { BellRing } from "lucide-react";
import { Button } from "@/components/ui/button";
import { subscribePushAction, unsubscribePushAction } from "@/lib/push/actions";

const WORKER_URL = "/push-sw.js";

function applicationServerKey(base64url: string): Uint8Array<ArrayBuffer> {
  const base64 = (base64url + "=".repeat((4 - (base64url.length % 4)) % 4))
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const raw = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function pushSupported(): boolean {
  return typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

/** "Order alerts on this device": web push for new orders while the inbox is closed. */
export function OrderAlertsToggle({ publicKey }: { publicKey: string | null }) {
  const [registration, setRegistration] = useState<ServiceWorkerRegistration | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!publicKey || !pushSupported()) return;
    let cancelled = false;
    navigator.serviceWorker
      .register(WORKER_URL)
      .then(async (reg) => {
        const existing = await reg.pushManager.getSubscription();
        if (cancelled) return;
        setRegistration(reg);
        if (!existing) return;
        // The browser may hold a subscription from another account on this device: link it to this user, or show "off".
        const linked = await subscribePushAction(existing.toJSON()).then((result) => result.ok, () => false);
        if (!cancelled) setEnabled(linked);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [publicKey]);

  if (!publicKey || !registration) return null;

  async function enable(reg: ServiceWorkerRegistration, key: string) {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      toast.error("Notifications are blocked for this site in your browser settings.");
      return;
    }
    const subscription = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: applicationServerKey(key),
    });
    const result = await subscribePushAction(subscription.toJSON());
    if (!result.ok) {
      await subscription.unsubscribe();
      toast.error("Could not turn on order alerts.");
      return;
    }
    setEnabled(true);
    toast.success("Order alerts are on for this device.");
  }

  async function disable(reg: ServiceWorkerRegistration) {
    const subscription = await reg.pushManager.getSubscription();
    if (subscription) {
      const removed = await unsubscribePushAction(subscription.endpoint);
      if (!removed.ok) {
        toast.error("Could not turn off order alerts.");
        return;
      }
      // The server row is gone, so no alert will arrive whether or not the browser lets go.
      await subscription.unsubscribe().catch(() => false);
    }
    setEnabled(false);
    toast.success("Order alerts are off for this device.");
  }

  async function toggle() {
    if (!registration || !publicKey) return;
    setBusy(true);
    try {
      if (enabled) await disable(registration);
      else await enable(registration, publicKey);
    } catch {
      toast.error("Could not change order alerts on this device.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button
      variant={enabled ? "secondary" : "outline"}
      size="sm"
      className="min-h-11"
      onClick={toggle}
      disabled={busy}
      aria-pressed={enabled}
    >
      <BellRing className="size-4" />
      {enabled ? "Order alerts on this device: on" : "Order alerts on this device: off"}
    </Button>
  );
}
