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
import { Store, Users, Package, Settings, CreditCard } from "lucide-react";

interface Props {
  storeName: string;
  storeSlug: string;
  userName: string;
  role: string;
  stripeOnboardingStatus: string;
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
}: Props) {
  const searchParams = useSearchParams();
  const storeParam = searchParams.get("store") ?? storeSlug;

  return (
    <div className="min-h-dvh bg-background">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-4 py-3">
          <div className="flex items-center gap-3">
            <div className="flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <Store className="size-5" />
            </div>
            <div>
              <h1 className="text-base font-semibold text-foreground">
                {storeName}
              </h1>
              <p className="text-xs text-muted-foreground">Store Admin</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted-foreground">{userName}</span>
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

        <div className="grid gap-4 sm:grid-cols-2">
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
