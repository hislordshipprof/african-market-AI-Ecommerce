"use client";

import { useState } from "react";

export function OrderCancel({ orderId, status }: { orderId: string; status: string }) {
  const [result, setResult] = useState<string | null>(status === "CANCELLED" ? "Cancelled" : null);
  const [busy, setBusy] = useState(false);
  if (status !== "AUTHORIZED" && status !== "CANCELLING" && status !== "CANCELLED") return null;

  async function cancel() {
    setBusy(true);
    try {
      const res = await fetch("/api/assistant/checkout/cancel", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orderId }),
      });
      const body = await res.json() as { ok?: boolean; message?: string };
      setResult(body.ok ? "Cancelled" : (body.message ?? "Contact the store."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      {result ? <p role="status">{result}</p> : null}
      {status !== "CANCELLED" && result !== "Cancelled" ? (
        <button type="button" data-testid="order-cancel" disabled={busy} onClick={() => { void cancel(); }}>
          {busy ? "Cancelling…" : "Cancel order"}
        </button>
      ) : null}
    </div>
  );
}
