"use client";

import { useState } from "react";
import Link from "next/link";
import { ChevronDown } from "lucide-react";
import { useRouter } from "next/navigation";
import { QRCodeSVG } from "qrcode.react";
import { authClient } from "@/lib/auth-client";
import { StoryCard, StorySurface } from "@/components/story-surface/story-surface";
import { Button } from "@/components/ui/button";
import { CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AUTHENTICATOR_ENTRY,
  AUTH_BACK,
  AUTH_CODE_HINT,
  AUTH_CODE_INPUT,
  AUTH_SUBMIT,
  AuthError,
  BackArrow,
  BackupCodesNotice,
  CopyRow,
  NETWORK_ERROR,
  PasswordInput,
  TOTP_ERRORS,
  authErrorMessage,
  fieldValue,
  NOT_READY_LABEL,
  focusField,
  missingField,
  totpDigits,
  useHydrated,
} from "../auth-form-parts";

const ERROR_ID = "admin-enroll-error";
const BACK_ID = "enroll-back";
const PASSWORD_ID = "enroll-password";
const CODE_ID = "enroll-code";
const SESSION_ENDED = "Your session ended. Go back and sign in again.";
const ENROLL_ERRORS = { INVALID_PASSWORD: "That password isn't right. Try again." };
// Starting setup again replaces the secret, so an entry saved earlier can never match.
const ENROLL_CODE_ERRORS = {
  ...TOTP_ERRORS,
  INVALID_CODE:
    "That code didn't match. Enter the newest one. If you ran setup more than once, delete the old entry in your app and add this one.",
};

// The submit button that had focus is gone after the step changes. Focus lands on the
// first instruction, because focusing the code field would open a phone keyboard over the page.
const focusOnMount = (instruction: HTMLParagraphElement | null) => instruction?.focus();

function setupKeyFrom(totpUri: string): string | null {
  try {
    return new URL(totpUri).searchParams.get("secret");
  } catch {
    return null;
  }
}

function QrCode({ value }: { value: string }) {
  return (
    // A QR code has to stay dark on white to scan, in both color schemes.
    <div className="mx-auto w-fit rounded-xl bg-white p-3">
      <QRCodeSVG value={value} size={136} level="M" title="Authenticator setup code" />
    </div>
  );
}

export default function Enroll2FA() {
  const router = useRouter();
  const hydrated = useHydrated();
  const [totpUri, setTotpUri] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [enrolling, setEnrolling] = useState(false);
  const [verified, setVerified] = useState(false);
  const [backupCodes, setBackupCodes] = useState<string[]>([]);

  async function startEnrollment(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const missing = missingField([[PASSWORD_ID, "Enter your current password."]]);
    if (missing) {
      setError(missing);
      return;
    }
    const password = fieldValue(e.currentTarget, PASSWORD_ID);
    setEnrolling(true);
    setError("");
    try {
      const result = await authClient.twoFactor.enable({
        password,
      });
      if (result.error) {
        if (result.error.status === 401) {
          setError(SESSION_ENDED);
          focusField(BACK_ID);
        } else {
          setError(authErrorMessage(result.error, ENROLL_ERRORS, "Failed to start enrollment"));
          focusField(PASSWORD_ID);
        }
        return;
      }
      const data = result.data;
      if (data && "totpURI" in data) {
        setTotpUri(data.totpURI ?? null);
        setBackupCodes(data.backupCodes ?? []);
      }
    } catch {
      setError(NETWORK_ERROR);
      focusField(PASSWORD_ID);
    } finally {
      setEnrolling(false);
    }
  }

  async function verifyCode(e: React.FormEvent) {
    e.preventDefault();
    if (code.length !== 6) {
      setError(`${AUTH_CODE_HINT}.`);
      focusField(CODE_ID);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const result = await authClient.twoFactor.verifyTotp({
        code,
      });
      if (result.error) {
        setError(authErrorMessage(result.error, ENROLL_CODE_ERRORS, "Invalid code"));
        setLoading(false);
        focusField(CODE_ID);
      } else if (backupCodes.length === 0) {
        router.push("/admin/stores");
      } else {
        setVerified(true);
        setLoading(false);
      }
    } catch {
      setError(NETWORK_ERROR);
      setLoading(false);
      focusField(CODE_ID);
    }
  }

  const setupKey = totpUri ? setupKeyFrom(totpUri) : null;
  const errorProps =
    error && error !== SESSION_ENDED ? { "aria-invalid": true, "aria-describedby": ERROR_ID } : {};

  return (
    <StorySurface>
      <StoryCard className="gap-5 py-6">
        <CardHeader className="px-6 sm:px-8">
          {!verified && (
            <Link id={BACK_ID} href="/admin/sign-in" className={AUTH_BACK}>
              <BackArrow />
              Back to sign in
            </Link>
          )}
          <h1 className="font-display text-[1.75rem] leading-tight font-bold text-balance">
            Set up <span className="whitespace-nowrap">two-factor</span>
          </h1>
          {!totpUri && (
            <CardDescription className="text-base">
              Required for all platform administrators. Confirm your password to start.
            </CardDescription>
          )}
        </CardHeader>

        <CardContent className="px-6 sm:px-8">
          {!totpUri && (
            <form onSubmit={startEnrollment} noValidate className="flex flex-col gap-4">
              {error && <AuthError id={ERROR_ID}>{error}</AuthError>}
              <div className="flex flex-col gap-2">
                <Label htmlFor={PASSWORD_ID}>Current password</Label>
                <PasswordInput
                  id={PASSWORD_ID}
                  required
                  autoComplete="current-password"
                  {...errorProps}
                />
              </div>
              <Button type="submit" disabled={enrolling || !hydrated} className={AUTH_SUBMIT}>
                {!hydrated ? NOT_READY_LABEL : enrolling ? "Setting up..." : "Begin setup"}
              </Button>
            </form>
          )}

          {verified && (
            <div className="flex flex-col gap-4">
              <p ref={focusOnMount} tabIndex={-1} className="text-base font-medium outline-none">
                Two-factor is on.
              </p>
              <BackupCodesNotice codes={backupCodes} />
              <Button type="button" onClick={() => router.push("/admin/stores")} className={AUTH_SUBMIT}>
                I&apos;ve saved them. Continue
              </Button>
            </div>
          )}

          {totpUri && !verified && (
            <div className="flex flex-col gap-5">
              <section className="flex flex-col gap-3">
                <p ref={focusOnMount} tabIndex={-1} className="text-base font-medium outline-none">
                  1. <span className="md:hidden">Add this account to</span>
                  <span className="hidden md:inline">Scan this code with</span> an authenticator app, such
                  as Google Authenticator or 1Password. Keep this page open until you&apos;ve entered the
                  code.
                </p>
                {/* A phone can't scan its own screen, so it leads with the app. */}
                <a
                  href={totpUri}
                  className="flex h-11 items-center justify-center rounded-full border border-input text-sm font-medium md:hidden"
                >
                  Open in authenticator app
                </a>
                <div className="hidden md:block">
                  <QrCode value={totpUri} />
                </div>
                <CopyRow label="Setup link" display={totpUri} value={totpUri} />
                {setupKey && (
                  <details className="group">
                    <summary className="flex h-11 cursor-pointer list-none items-center justify-center gap-1.5 rounded-full text-sm font-medium text-muted-foreground underline underline-offset-4 hover:text-foreground [&::-webkit-details-marker]:hidden">
                      <span className="md:hidden">Use another device or a setup key</span>
                      <span className="hidden md:inline">Can&apos;t scan? Enter a setup key</span>
                      <ChevronDown aria-hidden="true" className="size-4 group-open:rotate-180" />
                    </summary>
                    <div className="flex flex-col gap-3">
                      <div className="md:hidden">
                        <QrCode value={totpUri} />
                      </div>
                      <CopyRow
                        wrap
                        label="Setup key"
                        display={setupKey.replace(/(.{4})(?=.)/g, "$1 ")}
                        value={setupKey}
                      />
                    </div>
                  </details>
                )}
              </section>

              <form onSubmit={verifyCode} noValidate className="flex flex-col gap-3">
                <p className="text-base font-medium">
                  2. Enter the 6-digit code the app shows for {AUTHENTICATOR_ENTRY}. You&apos;ll use a new one
                  each time you sign in.
                </p>
                {error && <AuthError id={ERROR_ID}>{error}</AuthError>}
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
                  {loading ? "Verifying..." : "Verify and continue"}
                </Button>
              </form>
            </div>
          )}
        </CardContent>
      </StoryCard>
    </StorySurface>
  );
}
