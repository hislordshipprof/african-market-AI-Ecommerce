"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Store, ShieldCheck } from "lucide-react";
import { StoryCard, StorySurface } from "@/components/story-surface/story-surface";

type Step = "credentials" | "totp";

export default function StoreAdminSignIn() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const storeSlug = searchParams.get("store") ?? "";

  const [step, setStep] = useState<Step>("credentials");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleCredentials(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const result = await authClient.signIn.email({ email, password });

      if (result.error) {
        setError(result.error.message ?? "Sign-in failed");
      } else if (
        (result.data as Record<string, unknown>)?.twoFactorRedirect
      ) {
        setStep("totp");
      } else {
        router.push(`/store-admin?store=${storeSlug}`);
      }
    } catch {
      setError("Sign-in failed. Check your credentials.");
    } finally {
      setLoading(false);
    }
  }

  async function handleTotp(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const result = await authClient.twoFactor.verifyTotp({ code: totpCode });

      if (result.error) {
        setError(result.error.message ?? "Invalid code");
      } else {
        router.push(`/store-admin?store=${storeSlug}`);
      }
    } catch {
      setError("Verification failed. Try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <StorySurface>
      <StoryCard>
        <CardHeader className="text-center">
          <div className="mx-auto mb-2 flex size-12 items-center justify-center rounded-full bg-primary/10">
            <Store className="size-6 text-primary" />
          </div>
          <CardTitle className="text-xl font-display">Store Admin</CardTitle>
          <CardDescription>
            Sign in to manage your store
          </CardDescription>
        </CardHeader>

        <CardContent>
          {error && (
            <div className="mb-4 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              {error}
            </div>
          )}

          {step === "credentials" && (
            <form onSubmit={handleCredentials} className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="email"
                  placeholder="you@example.com"
                />
              </div>

              <div className="flex flex-col gap-2">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  type="password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                />
              </div>

              <Button type="submit" disabled={loading} className="w-full">
                {loading ? "Signing in..." : "Sign in"}
              </Button>
            </form>
          )}

          {step === "totp" && (
            <form onSubmit={handleTotp} className="flex flex-col gap-4">
              <div className="flex items-center gap-2 rounded-md bg-muted p-3">
                <ShieldCheck className="size-5 text-primary" />
                <p className="text-sm text-muted-foreground">
                  Enter the 6-digit code from your authenticator app.
                </p>
              </div>

              <div className="flex flex-col gap-2">
                <Label htmlFor="totp">Verification code</Label>
                <Input
                  id="totp"
                  type="text"
                  required
                  inputMode="numeric"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  value={totpCode}
                  onChange={(e) => setTotpCode(e.target.value)}
                  className="text-center text-lg tracking-[0.3em]"
                  autoComplete="one-time-code"
                />
              </div>

              <Button type="submit" disabled={loading} className="w-full">
                {loading ? "Verifying..." : "Verify"}
              </Button>
            </form>
          )}
        </CardContent>
      </StoryCard>
    </StorySurface>
  );
}
