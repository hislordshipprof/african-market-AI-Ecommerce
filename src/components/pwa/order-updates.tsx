"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { AlertCircle, BellRing } from "lucide-react";
import { subscribeOrderPushAction, unsubscribeOrderPushAction } from "@/lib/push/order-actions";
import { applicationServerKey, isIos, isStandalone, pushSupported, sameKey, WORKER_URL } from "@/lib/push/client";
import { rememberOrder } from "./install-prompt";

type State = "hidden" | "off" | "on" | "blocked";

const remembered = (token: string) => `pwa:order-push:${token.slice(0, 16)}`;
const noSubscribe = () => () => undefined;

/**
 * "Get updates on this device" on the tracking page. iOS delivers web push only to an app
 * added to the Home Screen, so there it asks for that first.
 */
export function OrderUpdates({ token, publicKey, storeName }: { token: string; publicKey: string | null; storeName: string }) {
  const [state, setState] = useState<State>("hidden");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const iosInBrowser = useSyncExternalStore(noSubscribe, () => isIos() && !isStandalone(), () => false);

  useEffect(() => {
    rememberOrder();
    if (!publicKey || iosInBrowser || !pushSupported()) return;
    let cancelled = false;
    navigator.serviceWorker
      .register(WORKER_URL)
      .then(async (reg) => {
        const existing = await reg.pushManager.getSubscription();
        if (cancelled) return;
        if (Notification.permission === "denied") return setState("blocked");
        const on = existing && sameKey(existing.options.applicationServerKey, applicationServerKey(publicKey)) && localStorage.getItem(remembered(token)) === "1";
        setState(on ? "on" : "off");
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [publicKey, token, iosInBrowser]);

  async function turnOn() {
    if (!publicKey) return;
    setBusy(true);
    setError(null);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setState("blocked");
        return;
      }
      const reg = await navigator.serviceWorker.register(WORKER_URL);
      const key = applicationServerKey(publicKey);
      let subscription = await reg.pushManager.getSubscription();
      if (subscription && !sameKey(subscription.options.applicationServerKey, key)) {
        await subscription.unsubscribe().catch(() => false);
        subscription = null;
      }
      subscription ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      const result = await subscribeOrderPushAction(token, subscription.toJSON());
      if (!result.ok) throw new Error(result.error);
      localStorage.setItem(remembered(token), "1");
      setState("on");
    } catch {
      setError("Could not turn on updates. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function turnOff() {
    setBusy(true);
    setError(null);
    try {
      const reg = await navigator.serviceWorker.register(WORKER_URL);
      const subscription = await reg.pushManager.getSubscription();
      // The browser keeps its subscription: this device may also get store alerts on it.
      if (subscription) {
        const result = await unsubscribeOrderPushAction(token, subscription.endpoint);
        if (!result.ok) throw new Error(result.error);
      }
      localStorage.removeItem(remembered(token));
      setState("off");
    } catch {
      setError("Could not turn off updates. Try again.");
    } finally {
      setBusy(false);
    }
  }

  if (publicKey && iosInBrowser) {
    return (
      <section className="sf-order-updates" aria-labelledby="sf-order-updates-title">
        <span className="sf-order-updates-icon"><BellRing size={20} aria-hidden /></span>
        <div className="sf-order-updates-body">
          <h2 id="sf-order-updates-title">Get updates on this iPhone</h2>
          <p>Add {storeName} to your Home Screen first (Share, then Add to Home Screen), then open it from there to turn on updates.</p>
        </div>
      </section>
    );
  }
  if (state === "hidden") return null;

  return (
    <section className="sf-order-updates" aria-labelledby="sf-order-updates-title">
      <span className="sf-order-updates-icon"><BellRing size={20} aria-hidden /></span>
      <div className="sf-order-updates-body">
        <h2 id="sf-order-updates-title">
          {state === "on" ? "Updates are on for this device" : "Get updates on this device"}
        </h2>
        {state === "off" && <p>We&rsquo;ll tell you when the store accepts your order, when it&rsquo;s ready and if anything changes.</p>}
        {state === "on" && <p>You&rsquo;ll get a notification when your order changes.</p>}
        {state === "blocked" && <p>Notifications are blocked for this site. Turn them on in your browser settings.</p>}
        {error && <p role="alert" className="sf-order-updates-error"><AlertCircle size={16} aria-hidden />{error}</p>}
      </div>
      {state === "off" && (
        <button type="button" className="sf-button" onClick={turnOn} disabled={busy}>Turn on updates</button>
      )}
      {state === "on" && (
        <button type="button" className="sf-install-later" onClick={turnOff} disabled={busy}>Turn off</button>
      )}
    </section>
  );
}
