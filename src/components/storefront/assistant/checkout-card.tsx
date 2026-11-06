"use client";

import { useEffect, useRef, useState } from "react";
import { money } from "@/lib/format";
import type { CheckoutCard } from "@/lib/assistant/ui/cards";
import styles from "./assistant.module.css";

type CardPayload = {
  ok: true;
  token: string;
  harness: boolean;
  publishableKey: string | null;
  onBehalfOf: string | null;
  amount: number | null;
};

export function CheckoutCardView({
  card,
  disabled,
  onChoice,
}: {
  card: CheckoutCard;
  disabled: boolean;
  onChoice: (text: string) => void;
}) {
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [orderId, setOrderId] = useState<string | null>(null);
  const cardMount = useRef<HTMLDivElement>(null);
  const stripeRef = useRef<{ submit: () => Promise<{ error?: { message?: string } }>; confirm: (secret: string) => Promise<string | null> } | null>(null);

  const cardQuery = card.attemptId ? `?attemptId=${encodeURIComponent(card.attemptId)}` : "";

  useEffect(() => {
    if (card.mode !== "confirm" || card.paymentKind === "saved") return;
    const mount = cardMount.current;
    let cancelled = false;
    void (async () => {
      const loaded = await fetch(`/api/assistant/checkout/card${cardQuery}`, { credentials: "same-origin" });
      const payload = await loaded.json() as CardPayload | { ok: false };
      if (cancelled || !loaded.ok || !payload.ok || payload.harness || !payload.publishableKey || !payload.amount || !payload.onBehalfOf || !mount) return;
      const stripeJs = await import("@stripe/stripe-js");
      const stripe = await stripeJs.loadStripe(payload.publishableKey);
      if (!stripe || cancelled) return;
      const elements = stripe.elements({
        mode: "payment",
        amount: payload.amount,
        currency: "usd",
        captureMethod: "manual",
        onBehalfOf: payload.onBehalfOf,
      });
      const payment = elements.create("payment");
      payment.mount(mount);
      stripeRef.current = {
        submit: async () => {
          const submitted = await elements.submit();
          return { error: submitted.error ? { message: submitted.error.message } : undefined };
        },
        confirm: async (secret) => {
          const confirmed = await stripe.confirmPayment({ clientSecret: secret, elements, redirect: "if_required", confirmParams: { return_url: window.location.href } });
          return confirmed.error?.message ?? null;
        },
      };
    })();
    return () => { cancelled = true; };
  }, [card.mode, card.paymentKind, cardQuery]);

  async function place() {
    setBusy(true);
    setNotice(null);
    try {
      const loaded = await fetch(`/api/assistant/checkout/card${cardQuery}`, { credentials: "same-origin" });
      const payload = await loaded.json() as CardPayload | { ok: false; message?: string };
      if (!loaded.ok || !payload.ok) {
        setNotice("message" in payload && payload.message ? payload.message : "That checkout is not available.");
        return;
      }
      if (stripeRef.current) {
        const submitted = await stripeRef.current.submit();
        if (submitted.error) {
          setNotice(submitted.error.message ?? "Check the card and try again.");
          return;
        }
      }
      const reserved = await postConfirm(payload.token, "reserve");
      if (!reserved.ok) {
        setNotice(reserved.message);
        return;
      }
      if (reserved.kind === "client_secret") {
        if (payload.harness) {
          const fake = await fetch("/api/e2e/fake-confirm", {
            method: "POST",
            credentials: "same-origin",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ paymentIntentId: reserved.paymentIntentId }),
          });
          if (!fake.ok) {
            setNotice("You have not been charged yet. Try again.");
            return;
          }
        } else if (card.paymentKind === "saved") {
          if (!payload.publishableKey) {
            setNotice("The card form is not available.");
            return;
          }
          const message = await confirmSavedCard(payload.publishableKey, reserved.clientSecret);
          if (message) {
            setNotice(message);
            return;
          }
        } else if (stripeRef.current) {
          const message = await stripeRef.current.confirm(reserved.clientSecret);
          if (message) {
            setNotice(message);
            return;
          }
        }
      }
      const placed = await postConfirm(payload.token, "complete");
      if (!placed.ok || placed.kind !== "order") {
        setNotice(placed.ok ? "You have not been charged yet. Try again." : placed.message);
        return;
      }
      setOrderId(placed.orderId);
    } finally {
      setBusy(false);
    }
  }

  async function cancel(id: string) {
    setBusy(true);
    try {
      const res = await fetch("/api/assistant/checkout/cancel", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orderId: id }),
      });
      const body = await res.json() as { ok?: boolean; message?: string };
      setNotice(body.ok ? "Cancelled" : (body.message ?? "Contact the store."));
    } finally {
      setBusy(false);
    }
  }

  async function saveContact(form: FormData) {
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch("/api/assistant/checkout/contact", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: String(form.get("name") ?? ""),
          email: String(form.get("email") ?? ""),
          phone: String(form.get("phone") ?? ""),
        }),
      });
      const body = await res.json() as { ok?: boolean; message?: string };
      setNotice(body.ok ? "Contact saved. You can prepare checkout again." : (body.message ?? "Check the contact details."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className={styles.summary} data-testid="assistant-checkout-card">
      <h3>Pickup order</h3>
      <p>{card.message}</p>
      {card.lines.length > 0 ? (
        <ul>
          {card.lines.map((line) => (
            <li key={line.name}>
              <span>{line.qty} × {line.name}</span>
              <span>{line.lineTotalCents ? money(line.lineTotalCents) : ""}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {card.slotLabel ? <p>{card.slotLabel}</p> : null}
      {card.feeCents ? <p>Fees {money(card.feeCents)}</p> : null}
      {card.bufferCents ? <p>Buffer {money(card.bufferCents)}. The final charge may be lower.</p> : null}
      {card.holdCents != null ? <p>Hold {money(card.holdCents)}. The final charge may be lower. Tax is $0.00.</p> : null}
      {card.cardLabel ? <p>{card.cardLabel}</p> : null}
      {card.mode === "confirm" && card.paymentKind !== "saved" ? <div ref={cardMount} data-testid="assistant-card-element" /> : null}
      {card.cancelMinutes ? <p>You can cancel for {card.cancelMinutes} minutes after placing.</p> : null}
      {card.mode === "slots" ? card.slots.map((slot) => (
        <button key={slot.id} type="button" className={styles.undo} disabled={disabled} onClick={() => onChoice(`Use pickup slot ${slot.id}`)}>
          {slot.label}
        </button>
      )) : null}
      {card.mode === "contact" ? (
        <form action={(form) => { void saveContact(form); }}>
          <label>Name<input name="name" autoComplete="name" required maxLength={200} /></label>
          <label>Email<input name="email" type="email" autoComplete="email" required maxLength={320} /></label>
          <label>Phone<input name="phone" type="tel" autoComplete="tel" required maxLength={40} /></label>
          <button type="submit" className={styles.undo} disabled={disabled || busy}>Save contact</button>
        </form>
      ) : null}
      {card.mode === "confirm" || card.mode === "recovery" ? (
        <button type="button" className={styles.undo} data-testid="assistant-place-order" disabled={disabled || busy || Boolean(orderId)} onClick={() => { void place(); }}>
          {busy ? "Placing…" : "Place order"}
        </button>
      ) : null}
      {orderId ? (
        <p>
          <a href={`/order/${orderId}`}>Order placed. View it.</a>
          <button type="button" data-testid="assistant-cancel-order" disabled={busy} onClick={() => { void cancel(orderId); }}>Cancel order</button>
        </p>
      ) : null}
      {notice ? <p role="status">{notice}</p> : null}
    </article>
  );
}

async function confirmSavedCard(publishableKey: string, secret: string): Promise<string | null> {
  const stripeJs = await import("@stripe/stripe-js");
  const stripe = await stripeJs.loadStripe(publishableKey);
  if (!stripe) return "The card form is not available.";
  const confirmed = await stripe.confirmPayment({
    clientSecret: secret,
    redirect: "if_required",
    confirmParams: { return_url: window.location.href },
  });
  return confirmed.error?.message ?? null;
}

async function postConfirm(token: string, phase: "reserve" | "complete") {
  const res = await fetch("/api/assistant/checkout/confirm", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, phase }),
  });
  return res.json() as Promise<
    | { ok: true; kind: "order"; orderId: string }
    | { ok: true; kind: "client_secret"; clientSecret: string; paymentIntentId: string }
    | { ok: true; kind: "saved"; paymentIntentId: string }
    | { ok: false; message: string }
  >;
}
