"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
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
import { Badge } from "@/components/ui/badge";
import { UserPlus, ShieldCheck } from "lucide-react";
import { StoryCard, StorySurface } from "@/components/story-surface/story-surface";
import { storeTwoFactorPath } from "@/lib/store-admin/sign-in-path";

type Step = "signup" | "totp-verify" | "accepting";

interface Props {
  token: string;
  storeName: string;
  storeSlug: string;
  role: string;
  email: string;
}

export function InviteAcceptForm({
  token,
  storeName,
  storeSlug,
  role,
  email,
}: Props) {
  const router = useRouter();
  const storeAdminHome = `/store-admin?store=${encodeURIComponent(storeSlug)}`;
  const [step, setStep] = useState<Step>("signup");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSignUp(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      // The invite creates the account server-side (public sign-up is closed), or adds a
      // password to a magic-link shopper's account. It never replaces an existing password.
      const added = await fetch("/api/invite/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password, name }),
      });
      if (!added.ok) {
        const data = (await added.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? "Sign-up failed");
        return;
      }
      const signInResult = await authClient.signIn.email({
        email,
        password,
      });
      if (signInResult.error) {
        setError(signInResult.error.message ?? "Sign-in failed");
        return;
      }
      if (
        (signInResult.data as Record<string, unknown>)?.twoFactorRedirect
      ) {
        setStep("totp-verify");
        return;
      }

      // 2FA is optional (#840): join first, then the setup page offers Set up now or Remind me later.
      if (!(await accept())) return;
      window.location.assign(storeTwoFactorPath(storeSlug, storeAdminHome));
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  async function handleTotpSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const result = await authClient.twoFactor.verifyTotp({ code: totpCode });
      if (result.error) {
        setError(result.error.message ?? "Invalid code");
        return;
      }
      if (!(await accept())) return;
      router.push(storeAdminHome);
    } catch {
      setError("Verification failed. Try again.");
    } finally {
      setLoading(false);
    }
  }

  async function accept(): Promise<boolean> {
    setStep("accepting");
    try {
      const res = await fetch(`/api/invite/accept`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        setError(data.error ?? "Failed to accept invitation");
        setStep("signup");
        return false;
      }
      return true;
    } catch {
      setError("Failed to accept invitation");
      setStep("signup");
      return false;
    }
  }

  return (
    <StorySurface>
      <StoryCard>
        <CardHeader className="text-center">
          <div className="mx-auto mb-2 flex size-12 items-center justify-center rounded-full bg-primary/10">
            <UserPlus className="size-6 text-primary" />
          </div>
          <CardTitle className="text-xl font-display">
            Join {storeName}
          </CardTitle>
          <CardDescription>
            You&apos;ve been invited as{" "}
            <Badge variant="secondary" className="ml-1">
              {role}
            </Badge>
          </CardDescription>
        </CardHeader>

        <CardContent>
          {error && (
            <div className="mb-4 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              {error}
            </div>
          )}

          {step === "signup" && (
            <form onSubmit={handleSignUp} className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  value={email}
                  disabled
                  className="bg-muted"
                />
              </div>

              <div className="flex flex-col gap-2">
                <Label htmlFor="name">Full name</Label>
                <Input
                  id="name"
                  type="text"
                  required
                  maxLength={80}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoComplete="name"
                  placeholder="Your full name"
                />
              </div>

              <div className="flex flex-col gap-2">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  type="password"
                  required
                  minLength={8}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="new-password"
                />
                <p className="text-xs text-muted-foreground">
                  At least 8 characters
                </p>
              </div>

              <Button type="submit" disabled={loading} className="w-full">
                {loading ? "Creating account..." : "Create account & continue"}
              </Button>
            </form>
          )}

          {step === "totp-verify" && (
            <form onSubmit={handleTotpSubmit} className="flex flex-col gap-4">
              <div className="flex items-center gap-2 rounded-md bg-muted p-3">
                <ShieldCheck className="size-5 shrink-0 text-primary" />
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
                {loading ? "Verifying..." : "Verify & join store"}
              </Button>
            </form>
          )}

          {step === "accepting" && (
            <div className="flex flex-col items-center gap-3 py-4">
              <div className="size-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
              <p className="text-sm text-muted-foreground">
                Setting up your access...
              </p>
            </div>
          )}
        </CardContent>
      </StoryCard>
    </StorySurface>
  );
}
