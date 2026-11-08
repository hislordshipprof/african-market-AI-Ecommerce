"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CircleAlert } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { authClient } from "@/lib/auth-client";
import { StoryCard, StorySurface } from "@/components/story-surface/story-surface";
import { Button } from "@/components/ui/button";
import { CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// The submit button that had focus is gone after the step changes.
const focusOnMount = (input: HTMLInputElement | null) => input?.focus();

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
          <h1 className="font-display text-2xl leading-tight font-bold text-balance">
            Set up two-factor authentication
          </h1>
          <CardDescription className="text-sm">
            Two-factor authentication is required for all platform administrators.
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
                  className="h-11"
                  autoComplete="current-password"
                  placeholder="Enter your password"
                />
              </div>
              <Button type="submit" disabled={enrolling} className="mt-2 h-11 w-full rounded-full">
                {enrolling ? "Setting up..." : "Begin setup"}
              </Button>
            </form>
          )}

          {totpUri && (
            <div className="flex flex-col gap-4">
              <p className="text-sm text-muted-foreground">
                Scan this code in your authenticator app. If you can&apos;t scan it, paste the setup
                link instead.
              </p>
              {/* A QR code has to stay dark on white to scan, in both color schemes. */}
              <div className="mx-auto rounded-xl bg-white p-3">
                <QRCodeSVG value={totpUri} size={168} level="M" title="Authenticator setup code" />
              </div>
              <code className="block rounded-lg bg-muted px-3 py-2 text-xs break-all text-muted-foreground">
                {totpUri}
              </code>

              <form onSubmit={verifyCode} className="flex flex-col gap-4">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="enroll-code">Verification code</Label>
                  <Input
                    ref={focusOnMount}
                    id="enroll-code"
                    type="text"
                    required
                    inputMode="numeric"
                    pattern="[0-9]{6}"
                    maxLength={6}
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    className="h-11 text-center text-lg tracking-[0.3em] md:text-lg"
                    autoComplete="one-time-code"
                    placeholder="000000"
                  />
                </div>
                <Button type="submit" disabled={loading} className="mt-2 h-11 w-full rounded-full">
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
