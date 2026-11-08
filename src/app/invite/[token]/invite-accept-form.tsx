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
import { QRCodeSVG } from "qrcode.react";
import { UserPlus, ShieldCheck } from "lucide-react";
import { StoryCard, StorySurface } from "@/components/story-surface/story-surface";

type Step = "signup" | "totp-enroll" | "totp-verify" | "accepting";

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
  const [step, setStep] = useState<Step>("signup");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [totpUri, setTotpUri] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSignUp(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const signUpResult = await authClient.signUp.email({
        email,
        password,
        name,
      });

      if (signUpResult.error) {
        if (
          signUpResult.error.message?.includes("already") ||
          signUpResult.error.code === "USER_ALREADY_EXISTS"
        ) {
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
          const existingEnrollResult = await authClient.twoFactor.enable({ password });
          if (existingEnrollResult.error) {
            setError("Failed to set up two-factor authentication");
            return;
          }
          setTotpUri((existingEnrollResult.data as Record<string, unknown>)?.totpURI as string ?? "");
          setStep("totp-enroll");
          return;
        }
        setError(signUpResult.error.message ?? "Sign-up failed");
        return;
      }

      const enrollResult = await authClient.twoFactor.enable({ password });
      if (enrollResult.error) {
        setError("Failed to set up two-factor authentication");
        return;
      }

      setTotpUri((enrollResult.data as Record<string, unknown>)?.totpURI as string ?? "");
      setStep("totp-enroll");
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
      await acceptAndRedirect();
    } catch {
      setError("Verification failed. Try again.");
    } finally {
      setLoading(false);
    }
  }

  async function acceptAndRedirect() {
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
        return;
      }
      router.push(`/store-admin?store=${storeSlug}`);
    } catch {
      setError("Failed to accept invitation");
      setStep("signup");
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

          {step === "totp-enroll" && (
            <form onSubmit={handleTotpSubmit} className="flex flex-col gap-4">
              <div className="flex items-center gap-2 rounded-md bg-muted p-3">
                <ShieldCheck className="size-5 shrink-0 text-primary" />
                <p className="text-sm text-muted-foreground">
                  Two-factor authentication is required. Scan this QR code with
                  your authenticator app, then enter the 6-digit code below.
                </p>
              </div>

              {totpUri && (
                <div className="flex justify-center rounded-md border border-border bg-card p-4">
                  <QRCodeSVG
                    value={totpUri}
                    size={200}
                    level="M"
                    className="rounded"
                  />
                </div>
              )}

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
