"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { StoryCard, StorySurface } from "@/components/story-surface/story-surface";
import { Button } from "@/components/ui/button";
import { CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AUTH_BACK,
  AUTH_INPUT,
  AUTH_SUBMIT,
  AuthError,
  BackArrow,
  NETWORK_ERROR,
  PasswordInput,
  authErrorMessage,
  fieldValue,
  focusField,
  useHydrated,
} from "../auth-form-parts";

const ERROR_ID = "reset-error";
const DESCRIPTION_ID = "reset-description";
const EMAIL_ID = "reset-email";
const PASSWORD_ID = "reset-password";
const RESET_ERRORS = {
  INVALID_TOKEN: "This reset link has expired or was already used. Ask for a new one.",
  PASSWORD_TOO_SHORT: "Use at least 8 characters.",
  PASSWORD_TOO_LONG: "Use at most 128 characters.",
};

type Step = "request" | "sent" | "choose" | "done";

function ResetPassword() {
  const params = useSearchParams();
  const token = params.get("token");
  const signInHref = params.get("from") === "store-admin" ? "/store-admin/sign-in" : "/admin/sign-in";
  const hydrated = useHydrated();
  const [step, setStep] = useState<Step>(token ? "choose" : "request");
  const [email, setEmail] = useState("");
  const [error, setError] = useState(params.get("error") === "INVALID_TOKEN" ? RESET_ERRORS.INVALID_TOKEN : "");
  const [loading, setLoading] = useState(false);

  async function requestLink(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const submitted = fieldValue(e.currentTarget, EMAIL_ID).trim().toLowerCase();
    setError("");
    setLoading(true);
    try {
      const result = await authClient.requestPasswordReset({
        email: submitted,
        redirectTo: `/admin/reset-password${params.get("from") === "store-admin" ? "?from=store-admin" : ""}`,
      });
      if (result.error) {
        setError(authErrorMessage(result.error, RESET_ERRORS, "Couldn't send the link. Try again."));
        focusField(EMAIL_ID);
      } else {
        setEmail(submitted);
        setStep("sent");
      }
    } catch {
      setError(NETWORK_ERROR);
      focusField(EMAIL_ID);
    } finally {
      setLoading(false);
    }
  }

  async function choosePassword(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const newPassword = fieldValue(e.currentTarget, PASSWORD_ID);
    setError("");
    setLoading(true);
    try {
      const result = await authClient.resetPassword({ newPassword, token: token ?? "" });
      if (result.error) {
        setError(authErrorMessage(result.error, RESET_ERRORS, "Couldn't change the password. Try again."));
        focusField(PASSWORD_ID);
      } else {
        setStep("done");
      }
    } catch {
      setError(NETWORK_ERROR);
      focusField(PASSWORD_ID);
    } finally {
      setLoading(false);
    }
  }

  const errorProps = error ? { "aria-invalid": true, "aria-describedby": ERROR_ID } : {};
  const description = {
    request: "Enter your account email. We'll send a link to choose a new password.",
    sent: `If ${email} has an account, a reset link is on its way. It expires in 1 hour.`,
    choose: "Choose a new password. You'll still confirm with your authenticator app when you sign in.",
    done: "Your password is changed, and every device was signed out.",
  }[step];

  return (
    <StorySurface>
      <StoryCard className="gap-6 py-8">
        <CardHeader className="grid-cols-[minmax(0,1fr)] px-6 sm:px-8">
          <Link href={signInHref} className={AUTH_BACK}>
            <BackArrow />
            Back to sign in
          </Link>
          <h1 className="font-display text-[1.75rem] leading-tight font-bold">
            {step === "done" ? "Password changed" : "Reset your password"}
          </h1>
          <CardDescription id={DESCRIPTION_ID} role={step === "sent" ? "status" : undefined} className="text-base [overflow-wrap:anywhere]">
            {description}
          </CardDescription>
        </CardHeader>

        <CardContent className="px-6 sm:px-8">
          {step === "request" && (
            <form onSubmit={requestLink} className="flex flex-col gap-4">
              {error && <AuthError id={ERROR_ID}>{error}</AuthError>}
              <div className="flex flex-col gap-2">
                <Label htmlFor={EMAIL_ID}>Email</Label>
                <Input id={EMAIL_ID} type="email" required autoComplete="email" className={AUTH_INPUT} {...errorProps} />
              </div>
              <Button type="submit" disabled={loading || !hydrated} className={AUTH_SUBMIT}>
                {loading ? "Sending..." : "Send reset link"}
              </Button>
            </form>
          )}

          {step === "choose" && (
            <form onSubmit={choosePassword} className="flex flex-col gap-4">
              {error && <AuthError id={ERROR_ID}>{error}</AuthError>}
              <div className="flex flex-col gap-2">
                <Label htmlFor={PASSWORD_ID}>New password</Label>
                <PasswordInput id={PASSWORD_ID} required minLength={8} autoComplete="new-password" {...errorProps} />
              </div>
              <Button type="submit" disabled={loading || !hydrated} className={AUTH_SUBMIT}>
                {loading ? "Saving..." : "Change password"}
              </Button>
            </form>
          )}

          {step === "done" && (
            <Link
              href={signInHref}
              className="flex h-12 w-full items-center justify-center rounded-full bg-primary text-base font-semibold text-primary-foreground"
            >
              Sign in
            </Link>
          )}
        </CardContent>
      </StoryCard>
    </StorySurface>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense>
      <ResetPassword />
    </Suspense>
  );
}
