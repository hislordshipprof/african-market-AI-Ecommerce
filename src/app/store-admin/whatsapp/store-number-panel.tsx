"use client";

import { useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { disconnectStoreNumberAction, linkStoreNumberAction } from "@/lib/whatsapp/store-number-actions";
import type { StoreNumberLinkMode, StoreNumberView } from "@/lib/whatsapp/store-number";

export interface StoreNumberState {
  status: StoreNumberView["status"];
  display: string;
  coexistence: boolean;
  failureCode: string | null;
}

interface Props {
  storeName: string;
  mode: StoreNumberLinkMode;
  number: StoreNumberState | null;
}

const STATUS: Record<StoreNumberState["status"], { label: string; variant: "secondary" | "outline" | "destructive" }> = {
  pending: { label: "Linking", variant: "secondary" },
  registered: { label: "Live", variant: "secondary" },
  failed: { label: "Not linked", variant: "destructive" },
  disconnected: { label: "Disconnected", variant: "outline" },
};

export function StoreNumberPanel({ storeName, mode, number }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const live = number?.status === "registered";

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setError(null);
    startTransition(async () => {
      const result = await linkStoreNumberAction(form);
      if ("error" in result) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  function disconnect() {
    setError(null);
    startTransition(async () => {
      const result = await disconnectStoreNumberAction();
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setConfirmDisconnect(false);
      router.refresh();
    });
  }

  return (
    <section aria-labelledby="store-number-heading" className="mt-10">
      <div className="mb-6">
        <h2 id="store-number-heading" className="text-lg font-semibold text-foreground">
          Your store&apos;s WhatsApp number
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Customers message this number to reach {storeName}. You can keep using the WhatsApp Business app on it.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{number ? number.display : "No number linked"}</CardTitle>
          <CardDescription className="mt-1">
            {number ? (
              <span className="flex flex-wrap items-center gap-2">
                <Badge variant={STATUS[number.status].variant}>{STATUS[number.status].label}</Badge>
                {number.coexistence && <span>Shared with the WhatsApp Business app</span>}
              </span>
            ) : (
              "Link the number your customers already know."
            )}
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-5">
          {live && (
            <p className="text-sm text-muted-foreground">
              Messages to this number reach {storeName} only. Ordering by WhatsApp comes later; until then, answer
              customers in the WhatsApp Business app.
            </p>
          )}
          {number?.status === "failed" && (
            <p className="text-sm text-muted-foreground">
              Meta did not accept this number{number.failureCode ? ` (code ${number.failureCode})` : ""}. Check the ids
              and link it again.
            </p>
          )}
          {number?.status === "pending" && (
            <p className="text-sm text-muted-foreground">Linking did not finish. Link the number again.</p>
          )}

          {mode === "unavailable" && (
            <p className="text-sm text-muted-foreground">
              WhatsApp isn&apos;t set up yet. You can link your number once the platform&apos;s WhatsApp account is
              connected.
            </p>
          )}
          {mode === "meta" && !live && (
            <p className="text-sm text-muted-foreground">
              Linking through Meta opens here once the platform&apos;s Meta app is approved. Ask platform support to
              link your number until then.
            </p>
          )}

          {mode === "form" && !live && (
            <form onSubmit={onSubmit} className="space-y-4">
              <p className="text-xs text-muted-foreground">
                Test mode: enter the ids Meta shows after signup.
              </p>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="store-waba-id">WhatsApp Business account ID</Label>
                  <Input id="store-waba-id" name="wabaId" inputMode="numeric" required maxLength={20} className="h-11 text-base" disabled={pending} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="store-phone-number-id">Phone number ID</Label>
                  <Input id="store-phone-number-id" name="phoneNumberId" inputMode="numeric" required maxLength={20} className="h-11 text-base" disabled={pending} />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="store-display-number">WhatsApp number</Label>
                <Input
                  id="store-display-number"
                  name="displayNumber"
                  type="tel"
                  inputMode="tel"
                  required
                  maxLength={32}
                  placeholder="(404) 555-0123"
                  className="h-11 text-base"
                  disabled={pending}
                />
              </div>
              <label className="flex min-h-11 items-start gap-3 text-sm text-foreground">
                <input type="checkbox" name="coexistence" defaultChecked className="mt-0.5 size-5 accent-primary" disabled={pending} />
                <span>
                  Keep using the WhatsApp Business app on this number
                  <span className="block text-xs text-muted-foreground">
                    Messages you send from the app still reach your customers.
                  </span>
                </span>
              </label>
              <Button type="submit" className="h-11 rounded-full px-5" disabled={pending}>
                {pending ? "Linking…" : "Link number"}
              </Button>
            </form>
          )}

          {error && (
            <p role="alert" className="flex items-start gap-2 rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2.5 text-sm text-destructive">
              <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span>{error}</span>
            </p>
          )}

          {number && number.status !== "disconnected" && (
            <div className="flex flex-wrap gap-2 border-t border-border pt-4">
              {confirmDisconnect ? (
                <>
                  <Button variant="destructive" className="h-11 rounded-full px-5" onClick={disconnect} disabled={pending}>
                    Disconnect number
                  </Button>
                  <Button variant="ghost" className="h-11 rounded-full" onClick={() => setConfirmDisconnect(false)} disabled={pending}>
                    Keep it
                  </Button>
                </>
              ) : (
                <Button variant="ghost" className="h-11 rounded-full text-destructive" onClick={() => setConfirmDisconnect(true)} disabled={pending}>
                  Disconnect
                </Button>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
