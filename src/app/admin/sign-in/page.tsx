"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { StoryCard, StorySurface } from "@/components/story-surface/story-surface";
import { Button } from "@/components/ui/button";
import { CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AUTHENTICATOR_ENTRY,
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
  NOT_READY_LABEL,
  SecondStepForm,
  missingField,
  useHydrated,
  CREDENTIALS_ERRORS,
} from "../auth-form-parts";

type Step = "credentials" | "totp";

const ERROR_ID = "admin-sign-in-error";
const DESCRIPTION_ID = "admin-sign-in-description";
const EMAIL_ID = "admin-email";
const PASSWORD_ID = "admin-password";
// Mouse and trackpad only: on a phone this would open the keyboard over the page.
const focusEmailOnDesktop = (input: HTMLInputElement | null) => {
  if (input && document.activeElement === document.body && window.matchMedia("(pointer: fine)").matches) {
    input.focus();
  }
};

export default function AdminSignIn() {
  const router = useRouter();
  const hydrated = useHydrated();
  const [step, setStep] = useState<Step>("credentials");
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleCredentials(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const missing = missingField([[EMAIL_ID, "Enter your email."], [PASSWORD_ID, "Enter your password."]]);
    if (missing) {
      setError(missing);
      return;
    }
    const submittedEmail = fieldValue(e.currentTarget, EMAIL_ID);
    const password = fieldValue(e.currentTarget, PASSWORD_ID);
    setEmail(submittedEmail);
    setError("");
    setLoading(true);

    try {
      const result = await authClient.signIn.email({
        email: submittedEmail,
        password,
      });

      if (result.error) {
        setError(authErrorMessage(result.error, CREDENTIALS_ERRORS, "Sign-in failed"));
        setLoading(false);
        focusField(PASSWORD_ID);
      } else if ((result.data as Record<string, unknown>)?.twoFactorRedirect) {
        setStep("totp");
        setLoading(false);
      } else {
        router.push("/admin/stores");
      }
    } catch {
      setError(NETWORK_ERROR);
      setLoading(false);
      focusField(PASSWORD_ID);
    }
  }

  function backToCredentials() {
    setStep("credentials");
    setError("");
  }

  const errorProps = error ? { "aria-invalid": true, "aria-describedby": ERROR_ID } : {};

  return (
    <StorySurface>
      <StoryCard className="gap-6 py-8">
        <CardHeader className="grid-cols-[minmax(0,1fr)] px-6 sm:px-8">
          {step === "totp" && (
            <button type="button" onClick={backToCredentials} className={`${AUTH_BACK} cursor-pointer`}>
              <BackArrow />
              Back to sign in
            </button>
          )}
          <h1 className="font-display text-[1.75rem] leading-tight font-bold">
            {step === "credentials" ? "Platform Admin" : "Confirm it's you"}
          </h1>
          <CardDescription id={DESCRIPTION_ID} className="text-base [overflow-wrap:anywhere]">
            {step === "credentials"
              ? "Sign in to manage stores and the catalog."
              : `Last step: enter the 6-digit code for ${AUTHENTICATOR_ENTRY} from your authenticator app, or a backup code, to finish signing in as ${email}.`}
          </CardDescription>
        </CardHeader>

        <CardContent className="px-6 sm:px-8">
          {step === "credentials" && (
            <form onSubmit={handleCredentials} noValidate className="flex flex-col gap-4">
              {error && <AuthError id={ERROR_ID}>{error}</AuthError>}
              <div className="flex flex-col gap-2">
                <Label htmlFor={EMAIL_ID}>Email</Label>
                <Input
                  ref={focusEmailOnDesktop}
                  id={EMAIL_ID}
                  type="email"
                  required
                  defaultValue={email}
                  className={AUTH_INPUT}
                  autoComplete="email"
                  {...errorProps}
                />
              </div>

              <div className="flex flex-col gap-2">
                <div className="flex items-baseline justify-between gap-3">
                  <Label htmlFor={PASSWORD_ID}>Password</Label>
                  <Link
                    href="/admin/reset-password"
                    className="text-sm font-medium text-muted-foreground underline underline-offset-4 hover:text-foreground"
                  >
                    Forgot password?
                  </Link>
                </div>
                <PasswordInput
                  id={PASSWORD_ID}
                  required
                  autoComplete="current-password"
                  {...errorProps}
                />
              </div>

              <Button type="submit" disabled={loading || !hydrated} className={AUTH_SUBMIT}>
                {!hydrated ? NOT_READY_LABEL : loading ? "Signing in..." : "Sign in"}
              </Button>
            </form>
          )}

          {step === "totp" && (
            <SecondStepForm
              idPrefix="admin"
              describedBy={DESCRIPTION_ID}
              onVerified={() => router.push("/admin/stores")}
            />
          )}
        </CardContent>
      </StoryCard>
    </StorySurface>
  );
}
