"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { StoryCard, StorySurface } from "@/components/story-surface/story-surface";
import { Button } from "@/components/ui/button";
import { CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AUTH_CODE_INPUT,
  AUTH_INPUT,
  AUTH_QUIET_ACTION,
  AUTH_SUBMIT,
  AuthError,
  totpDigits,
  totpErrorMessage,
} from "../auth-form-parts";

type Step = "credentials" | "totp";

const ERROR_ID = "admin-sign-in-error";

// Mouse and trackpad only: on a phone this would open the keyboard over the page.
const focusEmailOnDesktop = (input: HTMLInputElement | null) => {
  if (input && document.activeElement === document.body && window.matchMedia("(pointer: fine)").matches) {
    input.focus();
  }
};

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
        setLoading(false);
      } else if ((result.data as Record<string, unknown>)?.twoFactorRedirect) {
        setStep("totp");
        setLoading(false);
      } else {
        router.push("/admin/stores");
      }
    } catch {
      setError("Sign-in failed. Check your credentials.");
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
        setError(totpErrorMessage(result.error, "Invalid code"));
        setLoading(false);
      } else {
        router.push("/admin/stores");
      }
    } catch {
      setError("Verification failed. Try again.");
      setLoading(false);
    }
  }

  function backToCredentials() {
    setStep("credentials");
    setTotpCode("");
    setError("");
  }

  const errorProps = error ? { "aria-invalid": true, "aria-describedby": ERROR_ID } : {};

  return (
    <StorySurface>
      <StoryCard className="gap-6 py-8">
        <CardHeader className="px-6 sm:px-8">
          <h1 className="font-display text-[1.75rem] leading-tight font-bold">Platform Admin</h1>
          <CardDescription className="text-base">
            {step === "credentials"
              ? "Sign in to manage stores and the catalog."
              : `Enter the 6-digit code from your authenticator app to finish signing in as ${email}.`}
          </CardDescription>
        </CardHeader>

        <CardContent className="px-6 sm:px-8">
          {error && <AuthError id={ERROR_ID}>{error}</AuthError>}

          {step === "credentials" && (
            <form onSubmit={handleCredentials} className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor="admin-email">Email</Label>
                <Input
                  ref={focusEmailOnDesktop}
                  id="admin-email"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className={AUTH_INPUT}
                  autoComplete="email"
                  {...errorProps}
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
                  className={AUTH_INPUT}
                  autoComplete="current-password"
                  {...errorProps}
                />
              </div>

              <Button type="submit" disabled={loading} className={AUTH_SUBMIT}>
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
                  value={totpCode}
                  onChange={(e) => setTotpCode(totpDigits(e.target.value))}
                  className={AUTH_CODE_INPUT}
                  autoComplete="one-time-code"
                  {...errorProps}
                />
              </div>

              <Button type="submit" disabled={loading} className={AUTH_SUBMIT}>
                {loading ? "Verifying..." : "Verify"}
              </Button>
              <button type="button" onClick={backToCredentials} className={AUTH_QUIET_ACTION}>
                Back to sign in
              </button>
            </form>
          )}
        </CardContent>
      </StoryCard>
    </StorySurface>
  );
}
