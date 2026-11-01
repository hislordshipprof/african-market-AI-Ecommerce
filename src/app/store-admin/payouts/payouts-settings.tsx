"use client";

import { useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Store,
  CreditCard,
  ArrowLeft,
  ExternalLink,
  CheckCircle2,
  AlertCircle,
  Clock,
} from "lucide-react";

interface Props {
  storeName: string;
  storeSlug: string;
  stripeOnboardingStatus: string;
  hasStripeAccount: boolean;
}

const STATUS_CONFIG: Record<
  string,
  {
    label: string;
    description: string;
    variant: "default" | "secondary" | "destructive" | "outline";
    icon: typeof CheckCircle2;
    color: string;
  }
> = {
  not_started: {
    label: "Not started",
    description:
      "Connect your bank account to start accepting online payments and receiving weekly payouts.",
    variant: "outline",
    icon: CreditCard,
    color: "text-muted-foreground",
  },
  pending: {
    label: "Pending",
    description:
      "Your account has been created but onboarding is not complete. Continue setup to start accepting payments.",
    variant: "secondary",
    icon: Clock,
    color: "text-muted-foreground",
  },
  restricted: {
    label: "Needs information",
    description:
      "Stripe requires additional information to complete your account. Continue setup to provide the missing details.",
    variant: "destructive",
    icon: AlertCircle,
    color: "text-destructive",
  },
  complete: {
    label: "Complete",
    description:
      "Your store is ready to accept online payments. Payouts are sent weekly to your connected bank account.",
    variant: "default",
    icon: CheckCircle2,
    color: "text-success",
  },
};

export function PayoutsSettings({
  storeName,
  storeSlug,
  stripeOnboardingStatus,
  hasStripeAccount,
}: Props) {
  const searchParams = useSearchParams();
  const storeParam = searchParams.get("store") ?? storeSlug;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const config = STATUS_CONFIG[stripeOnboardingStatus] ?? STATUS_CONFIG.not_started;
  const StatusIcon = config.icon;
  const isComplete = stripeOnboardingStatus === "complete";
  const showConnectButton = !isComplete;

  async function handleConnect() {
    setLoading(true);
    setError(null);

    try {
      const res = await fetch(
        `/api/stripe/connect?store=${storeParam}`,
        { method: "POST" },
      );

      if (!res.ok) {
        const data = await res.json();
        setError(data.error ?? "Something went wrong");
        return;
      }

      const data = await res.json();
      if (data.url) {
        window.location.href = data.url;
      }
    } catch {
      setError("Could not connect to Stripe. Please try again.");
    } finally {
      setLoading(false);
    }
  }

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
              <p className="text-xs text-muted-foreground">Payouts</p>
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-4 py-6">
        <Link
          href={`/store-admin?store=${storeParam}`}
          className="mb-6 inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          Back to dashboard
        </Link>

        <div className="mb-6">
          <h2 className="text-lg font-semibold text-foreground">
            Payment setup
          </h2>
          <p className="text-sm text-muted-foreground">
            Connect your store to Stripe to accept payments
          </p>
        </div>

        <Card>
          <CardHeader>
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-3">
                <div className={`flex size-10 items-center justify-center rounded-lg ${isComplete ? "bg-success/10" : "bg-primary/10"}`}>
                  <StatusIcon className={`size-5 ${config.color}`} />
                </div>
                <div>
                  <CardTitle className="text-base">
                    Stripe Connect
                  </CardTitle>
                  <CardDescription className="flex items-center gap-2">
                    <Badge variant={config.variant}>{config.label}</Badge>
                  </CardDescription>
                </div>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              {config.description}
            </p>

            {error && (
              <div className="rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">
                {error}
              </div>
            )}

            {showConnectButton && (
              <Button
                onClick={handleConnect}
                disabled={loading}
                className="gap-2"
              >
                {loading ? (
                  "Redirecting to Stripe..."
                ) : hasStripeAccount ? (
                  <>
                    Continue setup
                    <ExternalLink className="size-4" />
                  </>
                ) : (
                  <>
                    Connect payouts
                    <ExternalLink className="size-4" />
                  </>
                )}
              </Button>
            )}

            {isComplete && (
              <div className="rounded-lg border border-success/20 bg-success/5 px-4 py-3">
                <p className="text-sm font-medium text-success">
                  Payments active
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Your store can now accept online orders. Customers will see
                  checkout enabled on your storefront.
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
