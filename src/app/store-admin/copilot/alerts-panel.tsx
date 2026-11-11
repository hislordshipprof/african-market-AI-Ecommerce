"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { answerCopilotAlert } from "@/lib/copilot/actions";
import type { AlertView } from "@/lib/copilot/alerts";

type Answer = { answer: "still_have"; qty: number } | { answer: "sold_out" } | { answer: "in_stock" };

export function AlertsPanel({ alerts: initialAlerts }: { alerts: AlertView[] }) {
  const [alerts, setAlerts] = useState(initialAlerts);
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (alerts.length === 0) return null;

  function answer(alert: AlertView, choice: Answer) {
    setBusyId(alert.id);
    startTransition(async () => {
      const result = await answerCopilotAlert({ alertId: alert.id, ...choice });
      if (result.ok) {
        setNotice(null);
        setAlerts((current) => current.filter((item) => item.listingId !== alert.listingId));
      } else {
        setNotice(result.code === "stale"
          ? "That item changed since this alert. Refresh the page."
          : "That alert is already answered. Refresh the page.");
      }
      setBusyId(null);
    });
  }

  return (
    <section aria-label="Stock alerts" className="mb-8 flex flex-col gap-3">
      <h2 className="font-display text-[1.375rem] leading-tight font-bold text-balance text-foreground">Stock alerts</h2>
      {notice ? <p role="status" className="text-sm text-destructive">{notice}</p> : null}
      {alerts.map((alert) => {
        const raw = counts[alert.id] ?? "";
        const qty = /^\d{1,6}$/.test(raw) ? Number(raw) : null;
        const busy = pending && busyId === alert.id;
        return (
          <article key={alert.id} className="rounded-xl border border-border bg-card px-4 py-4">
            <p className="text-base leading-6 text-foreground">{alert.text}</p>
            <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
              {alert.stockMode === "counted" ? (
                <>
                  <label className="flex items-center gap-2 text-sm text-muted-foreground">
                    <span>Count</span>
                    <input
                      inputMode="numeric"
                      value={raw}
                      onChange={(event) => setCounts((current) => ({ ...current, [alert.id]: event.target.value.trim() }))}
                      className="min-h-11 w-24 rounded-lg border border-border bg-background px-3 text-base text-foreground tabular-nums"
                    />
                  </label>
                  <Button
                    type="button"
                    className="min-h-11 rounded-full px-4"
                    disabled={pending || qty === null}
                    onClick={() => qty !== null && answer(alert, { answer: "still_have", qty })}
                  >
                    {busy ? "Saving…" : `Still have ${qty ?? "N"}`}
                  </Button>
                </>
              ) : (
                <Button
                  type="button"
                  className="min-h-11 rounded-full px-4"
                  disabled={pending}
                  onClick={() => answer(alert, { answer: "in_stock" })}
                >
                  In stock
                </Button>
              )}
              <Button
                type="button"
                variant="outline"
                className="min-h-11 rounded-full px-4"
                disabled={pending}
                onClick={() => answer(alert, { answer: "sold_out" })}
              >
                Sold out
              </Button>
            </div>
          </article>
        );
      })}
    </section>
  );
}
