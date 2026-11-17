"use client";

import { useState, useTransition } from "react";
import { Check, CircleAlert } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { updateAiCatalogAccess } from "@/lib/store-admin/directory-actions";

/** "Let AI assistants read my catalog" (#572). Saves on toggle; a failed save puts the switch back. */
export function AiCatalogCard({ initial }: { initial: boolean }) {
  const [readable, setReadable] = useState(initial);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  function toggle(next: boolean) {
    setReadable(next);
    setNotice(null);
    startTransition(async () => {
      const result = await updateAiCatalogAccess({ readable: next });
      if (result.ok) {
        setNotice({ ok: true, text: next ? "Turned on." : "Turned off." });
      } else {
        setReadable(!next);
        setNotice({ ok: false, text: result.message });
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">AI assistants</CardTitle>
        <CardDescription>
          Shopping assistants such as ChatGPT or Claude can search your products, prices and stock, and fill a cart that
          shoppers check out and pay for on your storefront. They never see your customers or orders, and cannot place an
          order.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex min-h-11 items-center justify-between gap-4">
          <label htmlFor="ai-catalog" className="text-sm font-medium text-foreground">
            Let AI assistants read my catalog
          </label>
          <Switch
            id="ai-catalog"
            checked={readable}
            disabled={pending}
            onCheckedChange={toggle}
            aria-describedby="ai-catalog-state"
          />
        </div>
        <p id="ai-catalog-state" className="text-sm text-muted-foreground">
          {readable ? "On. Assistants read your catalog from your storefront's address." : "Off. Assistants get nothing from your store."}
        </p>
        {/* Always rendered, so screen readers announce the result when it arrives. */}
        <p
          role="status"
          className={`flex items-center gap-1.5 text-sm empty:hidden ${notice?.ok === false ? "text-destructive" : "text-muted-foreground"}`}
        >
          {notice ? (
            <>
              {notice.ok ? <Check className="size-4" aria-hidden="true" /> : <CircleAlert className="size-4" aria-hidden="true" />}
              {notice.text}
            </>
          ) : null}
        </p>
      </CardContent>
    </Card>
  );
}
