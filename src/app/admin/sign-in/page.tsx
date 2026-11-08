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
  AUTH_BACK,
  AUTH_CODE_HINT,
  AUTH_CODE_INPUT,
  AUTH_INPUT,
  AUTH_SUBMIT,
  AuthError,
  BackArrow,
  PasswordInput,
  focusField,
  totpDigits,
  totpErrorMessage,
} from "../auth-form-parts";

type Step = "credentials" | "totp";

const ERROR_ID = "admin-sign-in-error";
const EMAIL_ID = "admin-email";
const TOTP_ID = "admin-totp";

// Mouse and trackpad only: on a phone this would open the keyboard over the page.
const focusEmailOnDesktop = (input: HTMLInputElement | null) => {
  if (input && document.activeElement === document.body && window.matchMedia("(pointer: fine)").matches) {
    input.focus();
  }
};

// The submit button that had focus is gone after the step changes.
const focusOnMount = (input: HTMLInputElement | null) => input?.focus();

function credentialsErrorMessage(error: { code?: string; message?: string }): string {
  if (error.code === "INVALID_EMAIL_OR_PASSWORD") {
    return "That email and password don't match. Check both and try again.";
  }
  return error.message ?? "Sign-in failed";
}

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
        setError(credentialsErrorMessage(result.error));
        setLoading(false);
        focusField(EMAIL_ID);
      } else if ((result.data as Record<string, unknown>)?.twoFactorRedirect) {
        setStep("totp");
        setLoading(false);
      } else {
        router.push("/admin/stores");
      }
    } catch {
      setError("Sign-in failed. Check your credentials.");
      setLoading(false);
      focusField(EMAIL_ID);
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
        focusField(TOTP_ID);
      } else {
        router.push("/admin/stores");
      }
    } catch {
      setError("Verification failed. Try again.");
      setLoading(false);
      focusField(TOTP_ID);
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
          {step === "totp" && (
            <button type="button" onClick={backToCredentials} className={`${AUTH_BACK} cursor-pointer`}>
              <BackArrow />
              Back to sign in
            </button>
          )}
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
                <Label htmlFor={EMAIL_ID}>Email</Label>
                <Input
                  ref={focusEmailOnDesktop}
                  id={EMAIL_ID}
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
                <PasswordInput
                  id="admin-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
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
                <Label htmlFor={TOTP_ID}>Verification code</Label>
                <Input
                  ref={focusOnMount}
                  id={TOTP_ID}
                  type="text"
                  required
                  inputMode="numeric"
                  pattern="[0-9]{6}"
                  title={AUTH_CODE_HINT}
                  value={totpCode}
                  onChange={(e) => setTotpCode(totpDigits(e.target.value))}
                  className={AUTH_CODE_INPUT}
                  autoComplete="one-time-code"
                  placeholder="000000"
                  {...errorProps}
                />
              </div>

              <Button type="submit" disabled={loading} className={AUTH_SUBMIT}>
                {loading ? "Verifying..." : "Verify"}
              </Button>
            </form>
          )}
        </CardContent>
      </StoryCard>
    </StorySurface>
  );
}
