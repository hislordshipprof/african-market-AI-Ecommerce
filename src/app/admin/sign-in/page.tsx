"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CircleAlert } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { StoryCard, StorySurface } from "@/components/story-surface/story-surface";
import { Button } from "@/components/ui/button";
import { CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Step = "credentials" | "totp";

// The submit button that had focus is gone after the step changes.
const focusOnMount = (input: HTMLInputElement | null) => input?.focus();

export default function AdminSignIn() {
  const router = useRouter();
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
      const result = await authClient.signIn.email({
        email,
        password,
      });

      if (result.error) {
        setError(result.error.message ?? "Sign-in failed");
      } else if ((result.data as Record<string, unknown>)?.twoFactorRedirect) {
        setStep("totp");
      } else {
        router.push("/admin/stores");
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
      const result = await authClient.twoFactor.verifyTotp({
        code: totpCode,
      });

      if (result.error) {
        setError(result.error.message ?? "Invalid code");
      } else {
        router.push("/admin/stores");
      }
    } catch {
      setError("Verification failed. Try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <StorySurface>
      <StoryCard className="gap-6 py-8">
        <CardHeader className="px-8">
          <h1 className="font-display text-2xl leading-tight font-bold">Platform Admin</h1>
          <CardDescription className="text-sm">
            {step === "credentials"
              ? "Sign in to manage stores and the catalog."
              : "Enter the 6-digit code from your authenticator app."}
          </CardDescription>
        </CardHeader>

        <CardContent className="px-8">
          {error && (
            <div
              role="alert"
              className="mb-4 flex gap-2 rounded-lg bg-destructive/10 p-3 text-sm text-destructive"
            >
              <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              {error}
            </div>
          )}

          {step === "credentials" && (
            <form onSubmit={handleCredentials} className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor="admin-email">Email</Label>
                <Input
                  id="admin-email"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="h-11"
                  autoComplete="email"
                />
              </div>

              <div className="flex flex-col gap-2">
                <Label htmlFor="admin-password">Password</Label>
                <Input
                  id="admin-password"
                  type="password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="h-11"
                  autoComplete="current-password"
                />
              </div>

              <Button type="submit" disabled={loading} className="mt-2 h-11 w-full rounded-full">
                {loading ? "Signing in..." : "Sign in"}
              </Button>
            </form>
          )}

          {step === "totp" && (
            <form onSubmit={handleTotp} className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor="admin-totp">Verification code</Label>
                <Input
                  ref={focusOnMount}
                  id="admin-totp"
                  type="text"
                  required
                  inputMode="numeric"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  value={totpCode}
                  onChange={(e) => setTotpCode(e.target.value)}
                  className="h-11 text-center text-lg tracking-[0.3em] md:text-lg"
                  autoComplete="one-time-code"
                />
              </div>

              <Button type="submit" disabled={loading} className="mt-2 h-11 w-full rounded-full">
                {loading ? "Verifying..." : "Verify"}
              </Button>
            </form>
          )}
        </CardContent>
      </StoryCard>
    </StorySurface>
  );
}
