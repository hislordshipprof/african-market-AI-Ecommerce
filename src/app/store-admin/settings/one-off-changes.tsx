"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CircleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { removeStoreChange } from "@/lib/store-admin/settings-actions";
import type { StoreChangeRef } from "@/lib/store-settings/store-change";

/** The one-day changes confirmed in the store chat (#819), each removable. Weekly hours are edited above. */
export function OneOffChanges({ changes }: { changes: { which: StoreChangeRef; text: string }[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  if (changes.length === 0) return null;

  function remove(which: StoreChangeRef) {
    setError(null);
    startTransition(async () => {
      const result = await removeStoreChange(which);
      if (result.ok) router.refresh();
      else setError(result.message);
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">One-day changes</CardTitle>
        <CardDescription>Made in the store chat. Each one ends on its own; your weekly hours stay the same.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <ul className="flex flex-col divide-y divide-border">
          {changes.map(({ which, text }) => (
            <li key={"date" in which ? which.date : "delivery-pause"} className="flex min-h-11 items-center justify-between gap-4 py-1">
              <span className="text-sm text-foreground">{text}</span>
              <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => remove(which)} aria-label={`Remove: ${text}`}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
        {error && (
          <p role="alert" className="flex items-center gap-1.5 text-sm text-destructive">
            <CircleAlert className="size-4" aria-hidden="true" />
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
