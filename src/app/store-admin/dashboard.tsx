"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { OwnerReportPanel } from "./copilot/owner-report-panel";
import { PlanLocked } from "@/components/store-admin/plan-locked";
import { AlertCircle, ChartColumn, Gem, Info, Store, Users, Package, Settings, CreditCard, ShoppingBag, MessageSquare, MessagesSquare, TicketPercent } from "lucide-react";

interface Props {
  storeName: string;
  storeSlug: string;
  userName: string;
  role: string;
  stripeOnboardingStatus: string;
  unreadMessages: number;
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
  plan,
}: Props) {
  const searchParams = useSearchParams();
  const storeParam = searchParams.get("store") ?? storeSlug;

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
          {role === "owner" && (
            <Link href={`/store-admin/plan?store=${storeParam}`}>
              <Card className="transition-shadow hover:shadow-md">
                <CardHeader>
                  <div className="flex items-center gap-3">
                    <div className="flex size-10 items-center justify-center rounded-lg bg-primary/10">
                      <Gem className="size-5 text-primary" />
                    </div>
                    <div>
                      <CardTitle className="text-base">Plan</CardTitle>
                      <CardDescription className="flex items-center gap-2">
                        {plan.name} plan
                        {plan.status === "trialing" && <Badge variant="secondary">Free trial</Badge>}
                        {plan.status === "none" && <Badge variant="outline">Choose a plan</Badge>}
                      </CardDescription>
                    </div>
                  </div>
                </CardHeader>
              </Card>
            </Link>
          )}

          {role === "owner" && (
            <Link href={`/store-admin/team?store=${storeParam}`}>
              <Card className="transition-shadow hover:shadow-md">
                <CardHeader>
                  <div className="flex items-center gap-3">
                    <div className="flex size-10 items-center justify-center rounded-lg bg-primary/10">
                      <Users className="size-5 text-primary" />
                    </div>
                    <div>
                      <CardTitle className="text-base">Team</CardTitle>
                      <CardDescription>
                        Manage staff and invitations
                      </CardDescription>
                    </div>
                  </div>
                </CardHeader>
              </Card>
            </Link>
          )}

          {role === "owner" && (
            <Link href={`/store-admin/promotions?store=${storeParam}`}>
              <Card className="transition-shadow hover:shadow-md">
                <CardHeader>
                  <div className="flex items-center gap-3">
                    <div className="flex size-10 items-center justify-center rounded-lg bg-primary/10">
                      <TicketPercent className="size-5 text-primary" />
                    </div>
                    <div>
                      <CardTitle className="text-base">Promotions</CardTitle>
                      <CardDescription>
                        Coupon codes for your shoppers
                      </CardDescription>
                    </div>
                  </div>
                </CardHeader>
              </Card>
            </Link>
          )}

          {role === "owner" && (
            <Link href={`/store-admin/payouts?store=${storeParam}`}>
              <Card className="transition-shadow hover:shadow-md">
                <CardHeader>
                  <div className="flex items-center gap-3">
                    <div className="flex size-10 items-center justify-center rounded-lg bg-primary/10">
                      <CreditCard className="size-5 text-primary" />
                    </div>
                    <div>
                      <CardTitle className="text-base">Payouts</CardTitle>
                      <CardDescription className="flex items-center gap-2">
                        Connect payments
                        <Badge variant={STATUS_LABELS[stripeOnboardingStatus]?.variant ?? "outline"}>
                          {STATUS_LABELS[stripeOnboardingStatus]?.label ?? stripeOnboardingStatus}
                        </Badge>
                      </CardDescription>
                    </div>
                  </div>
                </CardHeader>
              </Card>
            </Link>
          )}

          <Link href={`/store-admin/orders?store=${storeParam}`}>
            <Card className="transition-shadow hover:shadow-md">
              <CardHeader>
                <div className="flex items-center gap-3">
                  <div className="flex size-10 items-center justify-center rounded-lg bg-primary/10">
                    <ShoppingBag className="size-5 text-primary" />
                  </div>
                  <div>
                    <CardTitle className="text-base">Orders</CardTitle>
                    <CardDescription>
                      View and manage incoming orders
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>
            </Card>
          </Link>

          <Link href={`/store-admin/messages?store=${storeParam}`}>
            <Card className="transition-shadow hover:shadow-md">
              <CardHeader>
                <div className="flex items-center gap-3">
                  <div className="flex size-10 items-center justify-center rounded-lg bg-primary/10">
                    <MessagesSquare className="size-5 text-primary" />
                  </div>
                  <div>
                    <CardTitle className="text-base">Messages</CardTitle>
                    <CardDescription className="flex items-center gap-2">
                      Customer questions about orders
                      {unreadMessages > 0 && <Badge>{unreadMessages} unread</Badge>}
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>
            </Card>
          </Link>

          {role === "owner" && (
            <Link href={`/store-admin/copilot?store=${storeParam}`}>
              <Card className="transition-shadow hover:shadow-md">
                <CardHeader>
                  <div className="flex items-center gap-3">
                    <div className="flex size-10 items-center justify-center rounded-lg bg-primary/10">
                      <MessageSquare className="size-5 text-primary" />
                    </div>
                    <div>
                      <CardTitle className="text-base">Copilot</CardTitle>
                      <CardDescription>
                        Report stock in a sentence
                      </CardDescription>
                    </div>
                  </div>
                </CardHeader>
              </Card>
            </Link>
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

          <Link href={`/store-admin/listings?store=${storeParam}`}>
            <Card className="transition-shadow hover:shadow-md">
              <CardHeader>
                <div className="flex items-center gap-3">
                  <div className="flex size-10 items-center justify-center rounded-lg bg-primary/10">
                    <Package className="size-5 text-primary" />
                  </div>
                  <div>
                    <CardTitle className="text-base">Products</CardTitle>
                    <CardDescription>
                      Manage your listings and stock
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>
            </Card>
          </Link>

          {role === "owner" && plan.analyticsAllowed && (
            <Link href={`/store-admin/analytics?store=${storeParam}`}>
              <Card className="transition-shadow hover:shadow-md">
                <CardHeader>
                  <div className="flex items-center gap-3">
                    <div className="flex size-10 items-center justify-center rounded-lg bg-primary/10">
                      <ChartColumn className="size-5 text-primary" />
                    </div>
                    <div>
                      <CardTitle className="text-base">Analytics</CardTitle>
                      <CardDescription>Sales, best sellers and repeat shoppers</CardDescription>
                    </div>
                  </div>
                </CardHeader>
              </Card>
            </Link>
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

          <Card className="opacity-60">
            <CardHeader>
              <div className="flex items-center gap-3">
                <div className="flex size-10 items-center justify-center rounded-lg bg-primary/10">
                  <Settings className="size-5 text-primary" />
                </div>
                <div>
                  <CardTitle className="text-base">Settings</CardTitle>
                  <CardDescription>Coming soon</CardDescription>
                </div>
              </div>
            </CardHeader>
          </Card>
        </div>
      </main>
    </div>
  );
}
