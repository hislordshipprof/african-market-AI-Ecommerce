"use client";

import { useId, useState, useTransition } from "react";
import { updateDigestHour } from "@/lib/copilot/digest-actions";

function hourLabel(hour: number): string {
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:00 ${hour < 12 ? "AM" : "PM"}`;
}

export function DigestSetting({ hour: initialHour }: { hour: number }) {
  const id = useId();
  const [hour, setHour] = useState(initialHour);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function change(next: number) {
    const previous = hour;
    setHour(next);
    startTransition(async () => {
      const result = await updateDigestHour({ hour: next });
      if (result.ok) {
        setNotice("Saved.");
      } else {
        setHour(previous);
        setNotice("Could not save. Try again.");
      }
    });
  }

  return (
    <section aria-label="Daily digest" className="mt-8 rounded-xl border border-border bg-card px-4 py-4">
      <label htmlFor={id} className="text-base font-semibold text-foreground">Daily digest email</label>
      <p className="mt-1 text-sm text-muted-foreground">A summary of today&apos;s alerts, stock and sales, sent to owners at store time. The weekly report goes out on Mondays at the same hour.</p>
      <div className="mt-3 flex items-center gap-3">
        <select
          id={id}
          value={hour}
          disabled={pending}
          onChange={(event) => change(Number(event.target.value))}
          className="min-h-11 rounded-lg border border-border bg-background px-3 text-base text-foreground"
        >
          {Array.from({ length: 24 }, (_, h) => (
            <option key={h} value={h}>{hourLabel(h)}</option>
          ))}
        </select>
        {notice ? <p role="status" className="text-sm text-muted-foreground">{notice}</p> : null}
      </div>
    </section>
  );
}
