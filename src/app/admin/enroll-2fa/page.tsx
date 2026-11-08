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
  AUTH_CODE_INPUT,
  AUTH_INPUT,
  AUTH_QUIET_ACTION,
  AUTH_SUBMIT,
  AuthError,
  CopyRow,
  totpDigits,
  totpErrorMessage,
} from "../auth-form-parts";

const ERROR_ID = "admin-enroll-error";

// The submit button that had focus is gone after the step changes. Focus lands on the
// instructions, because focusing the code field would open a phone keyboard over the QR code.
const focusOnMount = (instructions: HTMLParagraphElement | null) => instructions?.focus();

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

  async function startEnrollment(e: React.FormEvent) {
    e.preventDefault();
    setEnrolling(true);
    setError("");
    try {
      const result = await authClient.twoFactor.enable({
        password,
      });
      if (result.error) {
        setError(result.error.message ?? "Failed to start enrollment");
        setEnrolling(false);
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
      } else {
        router.push("/admin/stores");
      }
    } catch {
      setError("Verification failed. Try again.");
      setLoading(false);
    }
  }

  const setupKey = totpUri ? setupKeyFrom(totpUri) : null;
  const errorProps = error ? { "aria-invalid": true, "aria-describedby": ERROR_ID } : {};

  return (
    <StorySurface>
      <StoryCard className="gap-6 py-8">
        <CardHeader className="px-6 sm:px-8">
          <h1 className="font-display text-[1.75rem] leading-tight font-bold text-balance">
            Set up <span className="whitespace-nowrap">two-factor</span> authentication
          </h1>
          <CardDescription className="text-base">
            Two-factor authentication is required for all platform administrators.
          </CardDescription>
        </CardHeader>

        <CardContent className="px-6 sm:px-8">
          {error && <AuthError id={ERROR_ID}>{error}</AuthError>}

          {!totpUri && (
            <form onSubmit={startEnrollment} className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor="enroll-password">Current password</Label>
                <Input
                  id="enroll-password"
                  type="password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className={AUTH_INPUT}
                  autoComplete="current-password"
                  placeholder="Enter your password"
                  {...errorProps}
                />
              </div>
              <Button type="submit" disabled={enrolling} className={AUTH_SUBMIT}>
                {enrolling ? "Setting up..." : "Begin setup"}
              </Button>
              <Link href="/admin/sign-in" className={AUTH_QUIET_ACTION}>
                Back to sign in
              </Link>
            </form>
          )}

          {totpUri && (
            <div className="flex flex-col gap-4">
              <p ref={focusOnMount} tabIndex={-1} className="text-sm text-muted-foreground outline-none">
                Scan this code with your authenticator app. You&apos;ll enter a code from the app each
                time you sign in.
              </p>
              {/* A QR code has to stay dark on white to scan, in both color schemes. */}
              <div className="mx-auto rounded-xl bg-white p-3">
                <QRCodeSVG value={totpUri} size={152} level="M" title="Authenticator setup code" />
              </div>
              {/* A phone can't scan its own screen. */}
              <a
                href={totpUri}
                className="flex h-11 items-center justify-center rounded-full border border-input text-sm font-medium md:hidden"
              >
                Open in authenticator app
              </a>
              <div className="flex flex-col gap-2">
                <CopyRow label="Setup link" display={totpUri} value={totpUri} />
                {setupKey && (
                  <CopyRow
                    label="Setup key"
                    display={setupKey.replace(/(.{4})(?=.)/g, "$1 ")}
                    value={setupKey}
                  />
                )}
              </div>

              <form onSubmit={verifyCode} className="flex flex-col gap-4">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="enroll-code">Verification code</Label>
                  <Input
                    id="enroll-code"
                    type="text"
                    required
                    inputMode="numeric"
                    pattern="[0-9]{6}"
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
                <Link href="/admin/sign-in" className={AUTH_QUIET_ACTION}>
                  Back to sign in
                </Link>
              </form>
            </div>
          )}
        </CardContent>
      </StoryCard>
    </StorySurface>
  );
}
