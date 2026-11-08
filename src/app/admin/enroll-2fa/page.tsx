"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { QRCodeSVG } from "qrcode.react";
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
  AUTH_SUBMIT,
  AuthError,
  BackArrow,
  CopyRow,
  PasswordInput,
  focusField,
  totpDigits,
  totpErrorMessage,
} from "../auth-form-parts";

const ERROR_ID = "admin-enroll-error";
const PASSWORD_ID = "enroll-password";
const CODE_ID = "enroll-code";
const SESSION_ENDED = "Your session ended. Go back and sign in again.";

// The submit button that had focus is gone after the step changes. Focus lands on the
// instructions, because focusing the code field would open a phone keyboard over the QR code.
const focusOnMount = (instructions: HTMLDivElement | null) => instructions?.focus();

function setupKeyFrom(totpUri: string): string | null {
  try {
    return new URL(totpUri).searchParams.get("secret");
  } catch {
    return null;
  }
}

export default function Enroll2FA() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [totpUri, setTotpUri] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [enrolling, setEnrolling] = useState(false);
  const [verified, setVerified] = useState(false);

  async function startEnrollment(e: React.FormEvent) {
    e.preventDefault();
    setEnrolling(true);
    setError("");
    try {
      const result = await authClient.twoFactor.enable({
        password,
      });
      if (result.error) {
        if (result.error.status === 401) {
          setError(SESSION_ENDED);
        } else {
          setError(result.error.message ?? "Failed to start enrollment");
          focusField(PASSWORD_ID);
        }
        return;
      }
      const data = result.data;
      if (data && "totpURI" in data) {
        setTotpUri(data.totpURI ?? null);
      }
    } catch {
      setError("Failed to start enrollment");
    } finally {
      setEnrolling(false);
    }
  }

  async function verifyCode(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      const result = await authClient.twoFactor.verifyTotp({
        code,
      });
      if (result.error) {
        setError(totpErrorMessage(result.error, "Invalid code"));
        setLoading(false);
        focusField(CODE_ID);
      } else {
        setVerified(true);
        router.push("/admin/stores");
      }
    } catch {
      setError("Verification failed. Try again.");
      setLoading(false);
      focusField(CODE_ID);
    }
  }

  const setupKey = totpUri ? setupKeyFrom(totpUri) : null;
  const errorProps =
    error && error !== SESSION_ENDED ? { "aria-invalid": true, "aria-describedby": ERROR_ID } : {};

  return (
    <StorySurface>
      <StoryCard className="gap-6 py-8">
        <CardHeader className="px-6 sm:px-8">
          <Link href="/admin/sign-in" className={AUTH_BACK}>
            <BackArrow />
            Back to sign in
          </Link>
          <h1 className="font-display text-[1.75rem] leading-tight font-bold text-balance">
            Set up <span className="whitespace-nowrap">two-factor</span> authentication
          </h1>
          {!totpUri && (
            <CardDescription className="text-base">
              Required for all platform administrators. Step 1 of 2: confirm your password.
            </CardDescription>
          )}
          {totpUri && (
            <CardDescription ref={focusOnMount} tabIndex={-1} className="text-base outline-none">
              <span className="md:hidden">
                Step 2 of 2: add this account to an authenticator app, such as Google Authenticator or
                1Password. You&apos;ll enter a code from the app each time you sign in.
              </span>
              <span className="hidden md:inline">
                Step 2 of 2: scan this code with an authenticator app, such as Google Authenticator or
                1Password. You&apos;ll enter a code from the app each time you sign in.
              </span>
            </CardDescription>
          )}
        </CardHeader>

        <CardContent className="px-6 sm:px-8">
          {error && <AuthError id={ERROR_ID}>{error}</AuthError>}

          {!totpUri && (
            <form onSubmit={startEnrollment} className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor={PASSWORD_ID}>Current password</Label>
                <PasswordInput
                  id={PASSWORD_ID}
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  {...errorProps}
                />
              </div>
              <Button type="submit" disabled={enrolling} className={AUTH_SUBMIT}>
                {enrolling ? "Setting up..." : "Begin setup"}
              </Button>
            </form>
          )}

          {totpUri && (
            <div className="flex flex-col gap-4">
              {/* A phone can't scan its own screen, so it leads with the app. */}
              <a
                href={totpUri}
                className="flex h-12 items-center justify-center rounded-full bg-primary text-base font-semibold text-primary-foreground md:hidden"
              >
                Open in authenticator app
              </a>
              <p className="text-center text-sm text-muted-foreground md:hidden">
                Or scan from another device
              </p>
              {/* A QR code has to stay dark on white to scan, in both color schemes. */}
              <div className="mx-auto rounded-xl bg-white p-3">
                <QRCodeSVG value={totpUri} size={152} level="M" title="Authenticator setup code" />
              </div>
              <div className="flex flex-col gap-2">
                <CopyRow label="Setup link" display={totpUri} value={totpUri} />
                {setupKey && (
                  <details>
                    <summary className="flex h-11 cursor-pointer items-center justify-center rounded-full text-sm font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
                      Can&apos;t scan? Enter a setup key
                    </summary>
                    <CopyRow
                      wrap
                      label="Setup key"
                      display={setupKey.replace(/(.{4})(?=.)/g, "$1 ")}
                      value={setupKey}
                    />
                  </details>
                )}
              </div>

              <form onSubmit={verifyCode} className="flex flex-col gap-4">
                <div className="flex flex-col gap-2">
                  <Label htmlFor={CODE_ID}>Verification code</Label>
                  <Input
                    id={CODE_ID}
                    type="text"
                    required
                    inputMode="numeric"
                    pattern="[0-9]{6}"
                    title={AUTH_CODE_HINT}
                    value={code}
                    onChange={(e) => setCode(totpDigits(e.target.value))}
                    className={AUTH_CODE_INPUT}
                    autoComplete="one-time-code"
                    placeholder="000000"
                    {...errorProps}
                  />
                </div>
                <Button type="submit" disabled={loading} className={AUTH_SUBMIT}>
                  {verified
                    ? "Two-factor is on. Opening stores..."
                    : loading
                      ? "Verifying..."
                      : "Verify and continue"}
                </Button>
              </form>
            </div>
          )}
        </CardContent>
      </StoryCard>
    </StorySurface>
  );
}
