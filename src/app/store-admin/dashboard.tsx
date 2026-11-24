"use client";

import { useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { OwnerReportPanel } from "./copilot/owner-report-panel";
import { PlanLocked } from "@/components/store-admin/plan-locked";
import type { GoLiveItemView } from "@/components/go-live/go-live-items";
import { displayAddress, GoLiveCard, LiveNotice } from "./go-live-card";
import { SignOutButton } from "./sign-out-button";
import { AlertCircle, Camera, ExternalLink, ChartColumn, ClipboardList, Gem, Info, MapPin, Store, Users, Package, Settings, CreditCard, ShoppingBag, MessageCircle, MessageSquare, MessagesSquare, TicketPercent, Truck, type LucideIcon } from "lucide-react";

interface Props {
  storeName: string;
  storeSlug: string;
  userName: string;
  role: string;
  stripeOnboardingStatus: string;
  unreadMessages: number;
  /** Orders placed by shoppers who arrived from the Store directory (#454). */
  directoryOrders: number;
  /** The go-live checklist while the store is in setup (#555); null once it is live. */
  goLive: GoLiveItemView[] | null;
  /** Where shoppers reach the store (#784); null when the slug cannot be routed. */
  storeAddress: string | null;
  minimumOrderCents: number;
  /** The store's address has a map point, so the directory can show it (#786). */
  located: boolean;
  plan: {
    name: string;
    status: string;
    paymentFailed: boolean;
    /** Set once the month passes 80% of the assistant chats. */
    chats: { used: number; cap: number; capped: boolean } | null;
    readOnly: boolean;
    reportsAllowed: boolean;
    analyticsAllowed: boolean;
    ownDomainAllowed: boolean;
  };
}

const STATUS_LABELS: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  not_started: { label: "Not started", variant: "outline" },
  pending: { label: "Pending", variant: "secondary" },
  restricted: { label: "Needs info", variant: "destructive" },
  complete: { label: "Complete", variant: "default" },
};

export function StoreAdminDashboard({
  storeName,
  storeSlug,
  userName,
  role,
  stripeOnboardingStatus,
  unreadMessages,
  directoryOrders,
  goLive,
  storeAddress,
  minimumOrderCents,
  located,
  plan,
}: Props) {
  const searchParams = useSearchParams();
  const storeParam = searchParams.get("store") ?? storeSlug;
  const [justLive, setJustLive] = useState(false);

  return (
    <div className="min-h-dvh bg-background">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-3 px-4 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <Store className="size-5" />
            </div>
            <div className="min-w-0">
              <h1 className="truncate text-base font-semibold text-foreground">
                {storeName}
              </h1>
              <p className="truncate text-xs text-muted-foreground">
                <span className="sm:hidden">{userName}</span>
                <span className="hidden sm:inline">Store Admin</span>
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <span className="hidden text-sm text-muted-foreground sm:inline">{userName}</span>
            <Badge variant="secondary">{role}</Badge>
            <SignOutButton storeSlug={storeSlug} />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-4 py-6">
        <div className="mb-6">
          <h2 className="text-lg font-semibold text-foreground">Dashboard</h2>
          <p className="text-sm text-muted-foreground">
            Manage your store and team
          </p>
        </div>

        {storeAddress && (
          <div className="mb-6 flex flex-col gap-3 rounded-xl border border-border bg-card p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="text-sm text-muted-foreground">Your store&apos;s web address</p>
              <p className="break-all text-base font-medium text-foreground" data-testid="store-address">{displayAddress(storeAddress)}</p>
            </div>
            <a
              href={storeAddress}
              target="_blank"
              rel="noreferrer"
              className={buttonVariants({ variant: "outline", className: "min-h-11 shrink-0 rounded-full" })}
            >
              View store
              <ExternalLink aria-hidden className="size-4" />
            </a>
          </div>
        )}

        {justLive && <LiveNotice storeAddress={storeAddress} storeParam={storeParam} minimumOrderCents={minimumOrderCents} located={located} />}
        {goLive && (
          <GoLiveCard items={goLive} isOwner={role === "owner"} minimumOrderCents={minimumOrderCents} located={located} onLive={() => setJustLive(true)} />
        )}

        {role === "owner" && plan.paymentFailed && (
          <div role="alert" className="mb-4 flex items-start gap-3 rounded-xl border border-destructive/40 bg-destructive/5 p-4">
            <AlertCircle className="mt-0.5 size-5 shrink-0 text-destructive" aria-hidden />
            <div className="text-sm">
              <p className="font-semibold text-foreground">Your subscription payment failed.</p>
              <p className="text-muted-foreground">
                Your store stays open.{" "}
                <Link href={`/store-admin/plan?store=${storeParam}`} className="font-medium text-primary underline underline-offset-4">
                  Update your card
                </Link>
              </p>
            </div>
          </div>
        )}
        {role === "owner" && plan.chats && (
          <div role="status" className="mb-4 flex items-start gap-3 rounded-xl border border-border bg-card p-4">
            <Info className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden />
            <p className="text-sm text-foreground">
              {plan.chats.capped
                ? "Your shopping assistant has used this month's chats and is paused. Shoppers keep buying by browsing."
                : `Your shopping assistant has used ${plan.chats.used.toLocaleString("en-US")} of ${plan.chats.cap.toLocaleString("en-US")} chats this month.`}{" "}
              <Link href={`/store-admin/plan?store=${storeParam}`} className="font-medium text-primary underline underline-offset-4">
                See plans
              </Link>
            </p>
          </div>
        )}
        {plan.readOnly && (
          <div role="status" className="mb-4 flex items-start gap-3 rounded-xl border border-border bg-card p-4">
            <Info className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden />
            <p className="text-sm text-foreground">
              You have read-only access. The store&apos;s plan has no seat left for you; ask the owner to upgrade or free a seat.
            </p>
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          {/* Daily work first (#725): orders, then messages, then products. */}
          <NavCard href={`/store-admin/orders?store=${storeParam}`} icon={ShoppingBag} title="Orders">
            View and manage incoming orders
          </NavCard>

          <NavCard href={`/store-admin/messages?store=${storeParam}`} icon={MessagesSquare} title="Messages">
            Customer questions about orders
            {unreadMessages > 0 && <Badge>{unreadMessages} unread</Badge>}
          </NavCard>

          <NavCard href={`/store-admin/listings?store=${storeParam}`} icon={Package} title="Products">
            {role === "owner" ? "Manage your listings and stock" : "Update stock and what is out of stock"}
          </NavCard>

          {role === "owner" && (
            <NavCard href={`/store-admin/plan?store=${storeParam}`} icon={Gem} title="Plan">
              {plan.name} plan
              {plan.status === "trialing" && <Badge variant="secondary">Free trial</Badge>}
              {plan.status === "none" && <Badge variant="outline">Choose a plan</Badge>}
            </NavCard>
          )}

          {role === "owner" && (
            <NavCard href={`/store-admin/team?store=${storeParam}`} icon={Users} title="Team">
              Manage staff and invitations
            </NavCard>
          )}

          {role === "owner" && (
            <NavCard href={`/store-admin/promotions?store=${storeParam}`} icon={TicketPercent} title="Promotions">
              Coupon codes for your shoppers
            </NavCard>
          )}

          {role === "owner" && (
            <NavCard href={`/store-admin/payouts?store=${storeParam}`} icon={CreditCard} title="Payouts">
              Connect payments
              <Badge variant={STATUS_LABELS[stripeOnboardingStatus]?.variant ?? "outline"}>
                {STATUS_LABELS[stripeOnboardingStatus]?.label ?? stripeOnboardingStatus}
              </Badge>
            </NavCard>
          )}

          {role === "owner" && (
            <NavCard href={`/store-admin/whatsapp?store=${storeParam}`} icon={MessageCircle} title="WhatsApp">
              Link your number for the Store copilot
            </NavCard>
          )}

          {role === "owner" && (
            <NavCard
              href={`/store-admin/directory?store=${storeParam}`}
              icon={MapPin}
              title="Directory listing"
              extra={
                <p className="mt-1 text-sm font-medium text-foreground">
                  {directoryOrders === 1 ? "1 order" : `${directoryOrders.toLocaleString("en-US")} orders`} from the directory
                </p>
              }
            >
              Show your store to shoppers nearby and to AI assistants
            </NavCard>
          )}

          {role === "owner" && (
            <NavCard href={`/store-admin/shipping?store=${storeParam}`} icon={Truck} title="Shipping">
              Ship dry goods to shoppers by parcel
            </NavCard>
          )}

          {role === "owner" && (
            <NavCard href={`/store-admin/copilot?store=${storeParam}`} icon={MessageSquare} title="Copilot">
              Report stock in a sentence
            </NavCard>
          )}

          {role === "owner" && (
            <NavCard href={`/store-admin/purchase-orders?store=${storeParam}`} icon={ClipboardList} title="Purchase orders">
              Order from your wholesalers
            </NavCard>
          )}

          {role !== "owner" && !plan.readOnly && plan.reportsAllowed && (
            <Card className="px-6 sm:col-span-2">
              <OwnerReportPanel submitOnly />
            </Card>
          )}
          {role !== "owner" && !plan.reportsAllowed && (
            <div className="sm:col-span-2">
              <PlanLocked
                title="Voice and photo stock reports"
                description="Tell the store what came in by voice or a photo of the invoice."
                storeSlug={storeParam}
                canUpgrade={false}
              />
            </div>
          )}

          {role !== "owner" && !plan.readOnly && (
            <NavCard href={`/store-admin/listings/from-photos?store=${storeParam}`} icon={Camera} title="Shelf photos">
              Photograph shelves to draft new listings
            </NavCard>
          )}

          {role === "owner" && plan.analyticsAllowed && (
            <NavCard href={`/store-admin/analytics?store=${storeParam}`} icon={ChartColumn} title="Analytics">
              Sales, best sellers and repeat shoppers
            </NavCard>
          )}
          {role === "owner" && !plan.analyticsAllowed && (
            <PlanLocked
              title="Analytics dashboard"
              description="Sales, best sellers and repeat shoppers at a glance."
              storeSlug={storeParam}
            />
          )}
          {role === "owner" && !plan.ownDomainAllowed && (
            <PlanLocked
              title="Your own domain"
              description="Serve your store at your own web address."
              storeSlug={storeParam}
            />
          )}

          {role === "owner" && (
            <NavCard href={`/store-admin/settings?store=${storeParam}`} icon={Settings} title="Settings">
              Hours, time zone, pickup, minimum order and phone
            </NavCard>
          )}
        </div>
      </main>
    </div>
  );
}

/** One dashboard link. Flat: hover and focus change the border and tone, never a shadow. */
function NavCard({
  href,
  icon: Icon,
  title,
  children,
  extra,
}: {
  href: string;
  icon: LucideIcon;
  title: string;
  children: React.ReactNode;
  extra?: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className="group/nav block rounded-xl outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <Card className="h-full transition-colors group-hover/nav:bg-muted/40 group-hover/nav:ring-foreground/25">
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10">
              <Icon className="size-5 text-primary" aria-hidden />
            </div>
            <div className="min-w-0">
              <CardTitle className="text-base">{title}</CardTitle>
              <CardDescription className="flex flex-wrap items-center gap-2">{children}</CardDescription>
              {extra}
            </div>
          </div>
        </CardHeader>
      </Card>
    </Link>
  );
}
