"use client";

import { useState } from "react";
import { Button, Chip } from "../primitives";
import styles from "./cart-checkout.module.css";

/** The one store coupon code a cart takes (#557): type a code, or see the one applied and remove it. */
export function CouponField({
  applied,
  apply,
  remove,
}: {
  applied: { code: string; message?: string } | null;
  apply: (code: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  remove: () => Promise<void>;
}) {
  const [code, setCode] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  async function run(work: () => Promise<void>) {
    setBusy(true);
    setMessage("");
    try {
      await work();
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className={styles.field} data-testid="coupon-field">
      <label htmlFor="coupon-code">Promo code</label>
      <div className={styles.inline}>
        <input
          id="coupon-code"
          value={code}
          disabled={busy}
          onChange={(event) => setCode(event.target.value)}
          placeholder="Enter a code"
          autoCapitalize="characters"
          autoComplete="off"
        />
        <Button
          type="button"
          disabled={busy || !code.trim()}
          onClick={() => run(async () => {
            const result = await apply(code);
            if (result.ok) setCode("");
            else setMessage(result.error);
          })}
        >
          Apply
        </Button>
      </div>
      {message && <p className={styles.muted} role="status">{message}</p>}
      {applied && (
        <div className={styles.inline} data-testid="applied-coupon">
          <p className={styles.muted} role="status">
            {applied.message ? `${applied.code}: ${applied.message}` : `${applied.code} applied`}
          </p>
          <Chip type="button" disabled={busy} onClick={() => run(remove)}>Remove</Chip>
        </div>
      )}
    </div>
  );
}
