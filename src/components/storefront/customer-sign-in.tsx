"use client";

import { useState, type FormEvent } from "react";
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
import { StoryCard, StorySurface } from "@/components/story-surface/story-surface";
import { Mail, ArrowLeft } from "lucide-react";

type Step = "form" | "sent";

interface Props {
  callbackUrl?: string;
  storeName: string;
  linkError?: string | null;
}

export function CustomerSignIn({
  callbackUrl = "/account",
  storeName,
  linkError = null,
}: Props) {
  const [email, setEmail] = useState("");
  const [step, setStep] = useState<Step>("form");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleSend(e: FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const result = await authClient.signIn.magicLink({
        email: email.trim().toLowerCase(),
        callbackURL: callbackUrl,
      });
      if (result.error) {
        setError(result.error.message ?? "Failed to send sign-in link");
        return;
      }
      setStep("sent");
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  function reset() {
    setStep("form");
    setEmail("");
    setError("");
  }

  const linkExpired = linkError === "INVALID_TOKEN";

  return (
    <StorySurface asMain={false}>
      <StoryCard>
        <CardHeader className="text-center">
          <CardTitle className="text-xl font-display">
            {step === "sent" ? "Check your email" : "Sign in"}
          </CardTitle>
          <CardDescription>
            {step === "sent"
              ? `We sent a sign-in link to ${email}`
              : `Sign in to ${storeName}`}
          </CardDescription>
        </CardHeader>

        <CardContent>
          {linkExpired && (
            <div
              className="mb-4 rounded-md bg-destructive/10 p-3 text-sm text-destructive"
              role="alert"
              aria-live="assertive"
            >
              This link has expired. Send a new one.
            </div>
          )}
          {error && (
            <div
              className="mb-4 rounded-md bg-destructive/10 p-3 text-sm text-destructive"
              role="alert"
              aria-live="assertive"
            >
              {error}
            </div>
          )}

          {step === "form" && (
            <form onSubmit={handleSend} className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor="email">Email address</Label>
                <Input
                  id="email"
                  type="email"
                  required
                  autoComplete="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>

              <Button type="submit" disabled={loading} className="w-full min-h-[44px]">
                {loading ? "Sending..." : "Send sign-in link"}
              </Button>
            </form>
          )}

          {step === "sent" && (
            <div className="flex flex-col items-center gap-4 py-2">
              <div className="flex size-12 items-center justify-center rounded-full bg-primary/10">
                <Mail className="size-6 text-primary-text" />
              </div>
              <p className="text-center text-sm text-muted-foreground">
                Click the link in your email to sign in. The link expires in
                15&nbsp;minutes.
              </p>
              <button
                type="button"
                onClick={reset}
                className="flex min-h-[44px] items-center justify-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
              >
                <ArrowLeft className="size-3" />
                Use a different email
              </button>
            </div>
          )}
        </CardContent>
      </StoryCard>
    </StorySurface>
  );
}
