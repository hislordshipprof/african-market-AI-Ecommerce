"use client";

import { useState, useTransition, type FormEvent } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { AlertCircle, ArrowLeft, CheckCircle2, MessageCircle, Store } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { removeWhatsAppLinkAction, startWhatsAppLinkAction } from "@/lib/whatsapp/actions";

export type LinkState =
  | { kind: "none" }
  | { kind: "waiting" | "expired"; phone: string; display: string }
  | { kind: "linked"; phone: string; display: string; since: string | null };

interface Props {
  storeName: string;
  storeSlug: string;
  configured: boolean;
  state: LinkState;
}

function ErrorNote({ message }: { message: string }) {
  return (
    <p role="alert" className="flex items-start gap-2 rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2.5 text-sm text-destructive">
      <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span>{message}</span>
    </p>
  );
}

export function WhatsAppLinkForm({ storeName, storeSlug, configured, state }: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const storeParam = searchParams.get("store") ?? storeSlug;
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  function sendCode(phone: string) {
    setError(null);
    startTransition(async () => {
      const form = new FormData();
      form.set("phone", phone);
      const result = await startWhatsAppLinkAction(form);
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setEditing(false);
      router.refresh();
    });
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = new FormData(event.currentTarget).get("phone");
    sendCode(typeof value === "string" ? value : "");
  }

  function remove() {
    setError(null);
    startTransition(async () => {
      const result = await removeWhatsAppLinkAction();
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setConfirmRemove(false);
      setEditing(false);
      router.refresh();
    });
  }

  const showForm = state.kind === "none" || editing;

  return (
    <div className="min-h-dvh bg-background">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-2xl items-center gap-3 px-4 py-3">
          <div className="flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Store className="size-5" aria-hidden />
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold text-foreground">{storeName}</h1>
            <p className="text-xs text-muted-foreground">WhatsApp</p>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-2xl px-4 py-6">
        <Link
          href={`/store-admin?store=${storeParam}`}
          className="mb-6 inline-flex min-h-11 items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-4" aria-hidden />
          Back to dashboard
        </Link>

        <div className="mb-6">
          <h2 className="text-lg font-semibold text-foreground">Your WhatsApp number</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Link the number you use on WhatsApp. The Store copilot will know it&apos;s you when you message the
            platform&apos;s WhatsApp number.
          </p>
        </div>

        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <div
                className={`flex size-10 shrink-0 items-center justify-center rounded-lg ${state.kind === "linked" ? "bg-success/10" : "bg-primary/10"}`}
              >
                {state.kind === "linked" ? (
                  <CheckCircle2 className="size-5 text-success" aria-hidden />
                ) : (
                  <MessageCircle className="size-5 text-primary" aria-hidden />
                )}
              </div>
              <div className="min-w-0">
                <CardTitle className="text-base">
                  {state.kind === "none" ? "Not linked" : state.display}
                </CardTitle>
                <CardDescription className="mt-1">
                  {state.kind === "none" && "We'll send a 6-digit code to this number on WhatsApp."}
                  {state.kind === "waiting" && <Badge variant="secondary">Waiting for your reply</Badge>}
                  {state.kind === "expired" && <Badge variant="outline">Code expired</Badge>}
                  {state.kind === "linked" && (
                    <span className="flex flex-wrap items-center gap-2">
                      <Badge className="bg-success/15 text-success">Linked</Badge>
                      {state.since && <span>since {state.since}</span>}
                    </span>
                  )}
                </CardDescription>
              </div>
            </div>
          </CardHeader>

          <CardContent className="space-y-5">
            {!configured && (
              <ErrorNote message="WhatsApp isn't set up yet. You can link your number once the platform's WhatsApp account is connected." />
            )}

            {state.kind === "waiting" && !editing && (
              <ol className="space-y-2 text-sm text-foreground">
                <li className="flex gap-3">
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold">1</span>
                  <span>Open WhatsApp on {state.display}.</span>
                </li>
                <li className="flex gap-3">
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold">2</span>
                  <span>Find our message with your 6-digit code.</span>
                </li>
                <li className="flex gap-3">
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold">3</span>
                  <span>
                    <strong className="font-semibold">Reply to that message with the code</strong> within 10 minutes, then
                    tap &ldquo;I&apos;ve replied&rdquo;.
                  </span>
                </li>
              </ol>
            )}

            {state.kind === "expired" && !editing && (
              <p className="text-sm text-muted-foreground">
                The code expired or couldn&apos;t be delivered. Send a new one, then reply to it on WhatsApp within 10
                minutes.
              </p>
            )}

            {state.kind === "linked" && !editing && (
              <p className="text-sm text-muted-foreground">
                Messages from this number to the platform&apos;s WhatsApp number reach {storeName}. If this isn&apos;t
                your number, remove it.
              </p>
            )}

            {showForm && (
              <form onSubmit={onSubmit} className="space-y-3" noValidate>
                <div className="space-y-1.5">
                  <Label htmlFor="whatsapp-phone">WhatsApp number</Label>
                  <Input
                    id="whatsapp-phone"
                    name="phone"
                    type="tel"
                    inputMode="tel"
                    autoComplete="tel"
                    maxLength={32}
                    required
                    placeholder="(404) 555-0123"
                    aria-describedby="whatsapp-phone-hint"
                    className="h-11 text-base"
                    disabled={!configured || pending}
                  />
                  <p id="whatsapp-phone-hint" className="text-xs text-muted-foreground">
                    US numbers can skip the +1. Other countries start with + and the country code.
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button type="submit" className="h-11 rounded-full px-5" disabled={!configured || pending}>
                    {pending ? "Sending…" : "Send code"}
                  </Button>
                  {editing && (
                    <Button type="button" variant="ghost" className="h-11 rounded-full" onClick={() => setEditing(false)}>
                      Cancel
                    </Button>
                  )}
                </div>
              </form>
            )}

            {error && <ErrorNote message={error} />}

            {state.kind !== "none" && !editing && (
              <div className="flex flex-wrap gap-2 border-t border-border pt-4">
                {state.kind === "waiting" && (
                  <Button className="h-11 rounded-full px-5" onClick={() => router.refresh()} disabled={pending}>
                    I&apos;ve replied
                  </Button>
                )}
                {state.kind !== "linked" && (
                  <Button
                    variant={state.kind === "expired" ? "default" : "outline"}
                    className="h-11 rounded-full px-5"
                    onClick={() => sendCode(state.phone)}
                    disabled={!configured || pending}
                  >
                    Send a new code
                  </Button>
                )}
                <Button variant="outline" className="h-11 rounded-full px-5" onClick={() => setEditing(true)} disabled={pending}>
                  {state.kind === "linked" ? "Change number" : "Use a different number"}
                </Button>
                {confirmRemove ? (
                  <span className="flex flex-wrap items-center gap-2">
                    <Button variant="destructive" className="h-11 rounded-full px-5" onClick={remove} disabled={pending}>
                      Remove number
                    </Button>
                    <Button variant="ghost" className="h-11 rounded-full" onClick={() => setConfirmRemove(false)} disabled={pending}>
                      Keep it
                    </Button>
                  </span>
                ) : (
                  <Button variant="ghost" className="h-11 rounded-full text-destructive" onClick={() => setConfirmRemove(true)} disabled={pending}>
                    Remove
                  </Button>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
