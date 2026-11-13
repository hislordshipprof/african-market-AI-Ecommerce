"use client";

import { useState } from "react";
import Link from "next/link";
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
import { Store } from "lucide-react";
import { StoryCard, StorySurface } from "@/components/story-surface/story-surface";
import {
  AUTH_INPUT,
  AUTH_SUBMIT,
  AuthError,
  NETWORK_ERROR,
  PasswordInput,
  NOT_READY_LABEL,
  SecondStepForm,
  authErrorMessage,
  missingField,
  fieldValue,
  focusField,
  useHydrated,
} from "@/app/admin/auth-form-parts";

type Step = "credentials" | "totp";

const ERROR_ID = "store-admin-sign-in-error";
const DESCRIPTION_ID = "store-admin-sign-in-description";
const EMAIL_ID = "email";
const PASSWORD_ID = "password";
const CREDENTIALS_ERRORS = {
  INVALID_EMAIL_OR_PASSWORD: "That email and password don't match. Check both and try again.",
  INVALID_EMAIL: "Enter a valid email address.",
};

export default function StoreAdminSignIn() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const storeSlug = searchParams.get("store") ?? "";
  const hydrated = useHydrated();

  const [step, setStep] = useState<Step>("credentials");
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const home = () => router.push(`/store-admin?store=${storeSlug}`);

  // Fields are uncontrolled: text typed before hydration stays in them and is what gets sent.
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
      const result = await authClient.signIn.email({ email: submittedEmail, password });
      if (result.error) {
        setError(authErrorMessage(result.error, CREDENTIALS_ERRORS, "Sign-in failed"));
        setLoading(false);
        focusField(PASSWORD_ID);
      } else if ((result.data as Record<string, unknown>)?.twoFactorRedirect) {
        setStep("totp");
        setLoading(false);
      } else {
        home();
      }
    } catch {
      setError(NETWORK_ERROR);
      setLoading(false);
      focusField(PASSWORD_ID);
    }
  }

  const errorProps = error ? { "aria-invalid": true, "aria-describedby": ERROR_ID } : {};

  return (
    <StorySurface>
      <StoryCard>
        <CardHeader className="text-center">
          <div className="mx-auto mb-2 flex size-12 items-center justify-center rounded-full bg-primary/10">
            <Store className="size-6 text-primary" />
          </div>
          <CardTitle className="text-xl font-display">Store Admin</CardTitle>
          <CardDescription id={DESCRIPTION_ID} className="[overflow-wrap:anywhere]">
            {step === "credentials"
              ? "Sign in to manage your store"
              : `Enter the 6-digit code from your authenticator app, or a backup code, to finish signing in as ${email}.`}
          </CardDescription>
        </CardHeader>

        <CardContent>
          {step === "credentials" && (
            <form onSubmit={handleCredentials} noValidate className="flex flex-col gap-4">
              {error && <AuthError id={ERROR_ID}>{error}</AuthError>}
              <div className="flex flex-col gap-2">
                <Label htmlFor={EMAIL_ID}>Email</Label>
                <Input
                  id={EMAIL_ID}
                  type="email"
                  required
                  defaultValue={email}
                  className={AUTH_INPUT}
                  autoComplete="email"
                  placeholder="you@example.com"
                  {...errorProps}
                />
              </div>

              <div className="flex flex-col gap-2">
                <div className="flex items-baseline justify-between gap-3">
                  <Label htmlFor={PASSWORD_ID}>Password</Label>
                  <Link
                    href="/admin/reset-password?from=store-admin"
                    className="text-sm font-medium text-muted-foreground underline underline-offset-4 hover:text-foreground"
                  >
                    Forgot password?
                  </Link>
                </div>
                <PasswordInput id={PASSWORD_ID} required autoComplete="current-password" {...errorProps} />
              </div>

              <Button type="submit" disabled={loading || !hydrated} className={AUTH_SUBMIT}>
                {!hydrated ? NOT_READY_LABEL : loading ? "Signing in..." : "Sign in"}
              </Button>
            </form>
          )}

          {step === "totp" && (
            <SecondStepForm idPrefix="store-admin" describedBy={DESCRIPTION_ID} onVerified={home} />
          )}
        </CardContent>
      </StoryCard>
    </StorySurface>
  );
}
