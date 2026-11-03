"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { StorySurface } from "@/components/story-surface/story-surface";
import { Phone, Mail, ArrowLeft } from "lucide-react";

type Channel = "phone" | "email";
type Step = "choose" | "otp" | "magic-link-sent";

interface Props {
  smsEnabled: boolean;
  callbackUrl?: string;
}

export function CustomerSignIn({ smsEnabled, callbackUrl = "/account" }: Props) {
  const router = useRouter();
  const [channel, setChannel] = useState<Channel>(smsEnabled ? "phone" : "email");
  const [destination, setDestination] = useState("");
  const [step, setStep] = useState<Step>("choose");
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleSendCode(e: FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      if (channel === "phone") {
        const result = await authClient.phoneNumber.sendOtp({
          phoneNumber: destination,
        });
        if (result.error) {
          setError(result.error.message ?? "Failed to send code");
          return;
        }
        setStep("otp");
      } else {
        const result = await authClient.signIn.magicLink({
          email: destination.trim().toLowerCase(),
          callbackURL: callbackUrl,
        });
        if (result.error) {
          setError(result.error.message ?? "Failed to send magic link");
          return;
        }
        setStep("magic-link-sent");
      }
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  async function handleVerifyOtp(e: FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const result = await authClient.phoneNumber.verify({
        phoneNumber: destination,
        code,
      });
      if (result.error) {
        setError(result.error.message ?? "Invalid code");
        return;
      }
      router.push(callbackUrl);
    } catch {
      setError("Verification failed. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  function reset() {
    setStep("choose");
    setCode("");
    setError("");
  }

  return (
    <StorySurface>
      <Card className="border-0 shadow-xl backdrop-blur-sm bg-card/95">
        <CardHeader className="text-center">
          <CardTitle className="text-xl font-display">
            {step === "otp"
              ? "Enter your code"
              : step === "magic-link-sent"
                ? "Check your email"
                : "Sign in"}
          </CardTitle>
          <CardDescription>
            {step === "otp"
              ? `We sent a 6-digit code to ${destination}`
              : step === "magic-link-sent"
                ? `We sent a sign-in link to ${destination}`
                : "Your markets. Your familiar favorites."}
          </CardDescription>
        </CardHeader>

        <CardContent>
          {error && (
            <div className="mb-4 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              {error}
            </div>
          )}

          {step === "choose" && (
            <form onSubmit={handleSendCode} className="flex flex-col gap-4">
              {smsEnabled && (
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setChannel("phone")}
                    className={`flex flex-1 items-center justify-center gap-2 rounded-md border p-3 text-sm transition-colors ${
                      channel === "phone"
                        ? "border-primary bg-primary/5 text-primary"
                        : "border-border text-muted-foreground hover:border-primary/50"
                    }`}
                  >
                    <Phone className="size-4" />
                    Phone
                  </button>
                  <button
                    type="button"
                    onClick={() => setChannel("email")}
                    className={`flex flex-1 items-center justify-center gap-2 rounded-md border p-3 text-sm transition-colors ${
                      channel === "email"
                        ? "border-primary bg-primary/5 text-primary"
                        : "border-border text-muted-foreground hover:border-primary/50"
                    }`}
                  >
                    <Mail className="size-4" />
                    Email
                  </button>
                </div>
              )}

              <div className="flex flex-col gap-2">
                <Label htmlFor="destination">
                  {channel === "phone" ? "Phone number" : "Email address"}
                </Label>
                <Input
                  id="destination"
                  type={channel === "phone" ? "tel" : "email"}
                  required
                  autoComplete={channel === "phone" ? "tel" : "email"}
                  placeholder={channel === "phone" ? "(555) 123-4567" : "you@example.com"}
                  value={destination}
                  onChange={(e) => setDestination(e.target.value)}
                />
              </div>

              <Button type="submit" disabled={loading} className="w-full">
                {loading
                  ? "Sending..."
                  : channel === "phone"
                    ? "Send verification code"
                    : "Send sign-in link"}
              </Button>
            </form>
          )}

          {step === "otp" && (
            <form onSubmit={handleVerifyOtp} className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor="otp-code">Verification code</Label>
                <Input
                  id="otp-code"
                  type="text"
                  required
                  inputMode="numeric"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  autoComplete="one-time-code"
                  placeholder="000000"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  className="text-center text-lg tracking-[0.3em]"
                />
              </div>

              <Button type="submit" disabled={loading} className="w-full">
                {loading ? "Verifying..." : "Verify and sign in"}
              </Button>

              <button
                type="button"
                onClick={reset}
                className="flex items-center justify-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
              >
                <ArrowLeft className="size-3" />
                Use a different phone or email
              </button>
            </form>
          )}

          {step === "magic-link-sent" && (
            <div className="flex flex-col items-center gap-4 py-2">
              <div className="flex size-12 items-center justify-center rounded-full bg-primary/10">
                <Mail className="size-6 text-primary" />
              </div>
              <p className="text-center text-sm text-muted-foreground">
                Click the link in your email to sign in. The link expires in
                5&nbsp;minutes.
              </p>
              <button
                type="button"
                onClick={reset}
                className="flex items-center justify-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
              >
                <ArrowLeft className="size-3" />
                Use a different email or phone
              </button>
            </div>
          )}
        </CardContent>
      </Card>
    </StorySurface>
  );
}
