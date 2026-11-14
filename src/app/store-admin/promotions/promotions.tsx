"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { ArrowLeft, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { createCouponAction, setCouponActiveAction, updateCouponAction } from "@/lib/coupon/actions";
import { money } from "@/lib/format";

export interface CouponRow {
  id: string;
  code: string;
  kind: "percent" | "fixed";
  percentOff: number | null;
  amountOffCents: number | null;
  minGoodsCents: number;
  startsLocal: string;
  endsLocal: string;
  startsLabel: string;
  endsLabel: string | null;
  totalUses: number | null;
  usesPerCustomer: number | null;
  firstOrderOnly: boolean;
  active: boolean;
  state: "live" | "scheduled" | "ended" | "inactive";
  usesSoFar: number;
  discountGivenCents: number;
}

interface Props {
  storeName: string;
  storeSlug: string;
  zoneName: string;
  /** Now in store time, the default start. */
  nowLocal: string;
  coupons: CouponRow[];
}

const STATE_LABEL: Record<CouponRow["state"], string> = { live: "Live", scheduled: "Scheduled", ended: "Ended", inactive: "Inactive" };

function dollars(cents: number | null): string {
  return cents === null ? "" : (cents / 100).toFixed(2).replace(/\.00$/, "");
}

function valueLabel(c: CouponRow): string {
  return c.kind === "percent" ? `${c.percentOff}% off` : `${money(c.amountOffCents ?? 0)} off`;
}

function rulesLabel(c: CouponRow): string {
  const rules = [
    c.minGoodsCents > 0 ? `Goods over ${money(c.minGoodsCents)}` : "No minimum",
    c.usesPerCustomer === null ? "Any number per customer" : `${c.usesPerCustomer} per customer`,
  ];
  if (c.firstOrderOnly) rules.push("First order only");
  return rules.join(" · ");
}

function CouponForm({ coupon, zoneName, nowLocal, onDone }: { coupon: CouponRow | null; zoneName: string; nowLocal: string; onDone: () => void }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [kind, setKind] = useState<"percent" | "fixed">(coupon?.kind ?? "percent");
  // `shown` changes on every failed save, so a repeated message is focused and announced again.
  const [error, setError] = useState<{ text: string; shown: number } | null>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);
  const valueLocked = (coupon?.usesSoFar ?? 0) > 0;
  const prefix = coupon ? `edit-${coupon.id}` : "new";

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    if (valueLocked && coupon) {
      data.set("kind", coupon.kind);
      data.set("percentOff", coupon.percentOff === null ? "" : String(coupon.percentOff));
      data.set("amountOff", dollars(coupon.amountOffCents));
    }
    startTransition(async () => {
      const result = coupon ? await updateCouponAction(coupon.id, data) : await createCouponAction(data);
      if (!result.ok) {
        setError({ text: result.error, shown: Date.now() });
        return;
      }
      setError(null);
      toast.success(coupon ? `${coupon.code} saved` : `${String(data.get("code")).toUpperCase()} created`);
      onDone();
      router.refresh();
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-5" aria-label={coupon ? `Edit ${coupon.code}` : "New code"}>
      <div className="flex flex-col gap-2">
        <Label htmlFor={`${prefix}-code`}>Code</Label>
        <Input
          id={`${prefix}-code`}
          name="code"
          required
          minLength={3}
          maxLength={20}
          pattern="[A-Za-z0-9\-]{3,20}"
          defaultValue={coupon?.code}
          placeholder="WELCOME10"
          autoCapitalize="characters"
          autoComplete="off"
          autoFocus
          spellCheck={false}
          className="h-11 font-mono uppercase"
          aria-describedby={`${prefix}-code-hint`}
        />
        <p id={`${prefix}-code-hint`} className="text-xs text-muted-foreground">3 to 20 letters, numbers or dashes. Shoppers can type it in any case.</p>
      </div>

      <fieldset className="flex flex-col gap-4" disabled={valueLocked} aria-describedby={valueLocked ? `${prefix}-locked` : undefined}>
        <legend className="mb-2 text-sm font-medium text-foreground">Discount on goods</legend>
        <div className="flex gap-2">
          {(["percent", "fixed"] as const).map((k) => (
            <label
              key={k}
              className="flex h-11 flex-1 cursor-pointer items-center justify-center gap-2 rounded-lg border border-input px-3 text-sm text-foreground has-checked:border-primary has-checked:ring-2 has-checked:ring-primary has-focus-visible:ring-3 has-focus-visible:ring-ring/50 has-disabled:cursor-not-allowed has-disabled:opacity-60"
            >
              <input type="radio" name="kind" value={k} checked={kind === k} onChange={() => setKind(k)} className="sr-only" />
              {k === "percent" ? "Percent off" : "Dollars off"}
            </label>
          ))}
        </div>
        {kind === "percent" ? (
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${prefix}-percent`}>Percent (1 to 90)</Label>
            <Input id={`${prefix}-percent`} name="percentOff" type="number" inputMode="numeric" min={1} max={90} step={1} required defaultValue={coupon?.percentOff ?? ""} className="h-11" />
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${prefix}-amount`}>Amount in dollars ($1 to $100)</Label>
            <Input id={`${prefix}-amount`} name="amountOff" type="number" inputMode="decimal" min={1} max={100} step={0.01} required defaultValue={dollars(coupon?.amountOffCents ?? null)} className="h-11" />
          </div>
        )}
        {valueLocked && (
          <p id={`${prefix}-locked`} className="text-xs text-muted-foreground">This code has been used, so its type and value are fixed. Deactivate it and create a new one to change them.</p>
        )}
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${prefix}-min`}>Minimum goods ($)</Label>
          <Input id={`${prefix}-min`} name="minGoods" type="number" inputMode="decimal" min={0} step={0.01} defaultValue={coupon && coupon.minGoodsCents > 0 ? dollars(coupon.minGoodsCents) : ""} placeholder="No minimum" className="h-11" />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${prefix}-total`}>Total uses</Label>
          <Input id={`${prefix}-total`} name="totalUses" type="number" inputMode="numeric" min={1} step={1} defaultValue={coupon?.totalUses ?? ""} placeholder="No limit" className="h-11" />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${prefix}-per`}>Uses per customer</Label>
          <Input id={`${prefix}-per`} name="usesPerCustomer" type="number" inputMode="numeric" min={1} step={1} defaultValue={coupon ? (coupon.usesPerCustomer ?? "") : 1} placeholder="No limit" className="h-11" />
        </div>
        <label className="flex min-h-11 cursor-pointer items-center gap-3 self-end text-sm text-foreground">
          <input type="checkbox" name="firstOrderOnly" defaultChecked={coupon?.firstOrderOnly ?? false} className="size-5 accent-primary" />
          First order only
        </label>
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${prefix}-starts`}>Starts ({zoneName})</Label>
          <Input id={`${prefix}-starts`} name="startsAt" type="datetime-local" required defaultValue={coupon?.startsLocal ?? nowLocal} className="h-11" />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${prefix}-ends`}>Ends ({zoneName})</Label>
          <Input id={`${prefix}-ends`} name="endsAt" type="datetime-local" defaultValue={coupon?.endsLocal ?? ""} className="h-11" />
        </div>
      </div>

      {error && (
        <p ref={errorRef} tabIndex={-1} role="alert" className="text-sm text-destructive outline-none" key={error.shown}>{error.text}</p>
      )}

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="ghost" className="h-11" onClick={onDone} disabled={isPending}>Cancel</Button>
        <Button type="submit" className="h-11" disabled={isPending}>
          {isPending ? "Saving…" : coupon ? "Save changes" : "Create code"}
        </Button>
      </div>
    </form>
  );
}

export function Promotions({ storeName, storeSlug, zoneName, nowLocal, coupons }: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const storeParam = searchParams.get("store") ?? storeSlug;
  const [isPending, startTransition] = useTransition();
  const [editing, setEditing] = useState<string | null>(null);

  function toggleActive(c: CouponRow) {
    startTransition(async () => {
      const result = await setCouponActiveAction(c.id, !c.active);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success(c.active ? `${c.code} deactivated` : `${c.code} activated`);
      router.refresh();
    });
  }

  return (
    <div className="min-h-dvh bg-background">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 py-3">
          <Link
            href={`/store-admin?store=${storeParam}`}
            aria-label="Back to store admin"
            className="inline-flex size-11 items-center justify-center rounded-lg text-foreground outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <ArrowLeft className="size-4" aria-hidden />
          </Link>
          <div>
            <h1 className="text-base font-semibold text-foreground">Promotions</h1>
            <p className="text-[13px] text-muted-foreground">{storeName}</p>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 py-6">
        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <CardTitle className="text-base"><h2>Coupon codes</h2></CardTitle>
                  <CardDescription>Your store pays for every discount. Codes take money off goods only, never fees or tips.</CardDescription>
                </div>
                {editing !== "new" && (
                  <Button className="h-11" onClick={() => setEditing("new")}>
                    <Plus className="size-4" data-icon="inline-start" aria-hidden />
                    New code
                  </Button>
                )}
              </div>
            </CardHeader>
            {editing === "new" && (
              <CardContent>
                <CouponForm coupon={null} zoneName={zoneName} nowLocal={nowLocal} onDone={() => setEditing(null)} />
              </CardContent>
            )}
          </Card>

          {coupons.length === 0 && editing !== "new" ? (
            <p className="px-1 text-sm text-muted-foreground">No codes yet. Create one to share with your shoppers.</p>
          ) : (
            <ul className="flex flex-col gap-3" aria-label="Codes">
              {coupons.map((c) => (
                <li key={c.id}>
                  <Card>
                    <CardContent className="flex flex-col gap-4">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="flex min-w-0 flex-col gap-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <h3 className="font-mono text-base font-semibold tracking-wide text-foreground" translate="no">{c.code}</h3>
                            <Badge variant={c.state === "live" ? "secondary" : "outline"}>{STATE_LABEL[c.state]}</Badge>
                          </div>
                          <p className="text-sm text-foreground">{valueLabel(c)}</p>
                          <p className="text-[13px] text-muted-foreground">{rulesLabel(c)}</p>
                          <p className="text-[13px] text-muted-foreground">
                            {c.startsLabel} – {c.endsLabel ?? "no end date"}
                          </p>
                        </div>
                        <dl className="grid grid-cols-2 gap-x-6 text-right text-sm sm:min-w-48">
                          <div>
                            <dt className="text-[13px] text-muted-foreground">Uses</dt>
                            <dd className="font-medium tabular-nums text-foreground">
                              {c.usesSoFar}{c.totalUses !== null ? ` of ${c.totalUses}` : ""}
                            </dd>
                          </div>
                          <div>
                            <dt className="text-[13px] text-muted-foreground">Discount given</dt>
                            <dd className="font-medium tabular-nums text-foreground">{money(c.discountGivenCents)}</dd>
                          </div>
                        </dl>
                      </div>
                      {editing === c.id ? (
                        <CouponForm coupon={c} zoneName={zoneName} nowLocal={nowLocal} onDone={() => setEditing(null)} />
                      ) : (
                        <div className="flex gap-2">
                          <Button variant="outline" className="h-11" aria-label={`Edit ${c.code}`} onClick={() => setEditing(c.id)} disabled={isPending}>
                            Edit
                          </Button>
                          <Button variant="ghost" className="h-11" aria-label={`${c.active ? "Deactivate" : "Activate"} ${c.code}`} onClick={() => toggleActive(c)} disabled={isPending}>
                            {c.active ? "Deactivate" : "Activate"}
                          </Button>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                </li>
              ))}
            </ul>
          )}
        </div>
      </main>
    </div>
  );
}
