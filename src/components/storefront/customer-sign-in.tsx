"use client";

import { useActionState, useState } from "react";
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
import { sendSignInLinkAction, type SignInLinkState } from "@/lib/customer-sign-in/actions";
import { Mail, ArrowLeft } from "lucide-react";

interface Props {
  storeName: string;
  linkError?: string | null;
}

const INITIAL: SignInLinkState = { status: "idle", email: "" };

export function CustomerSignIn({ storeName, linkError = null }: Props) {
  // A server action, so a submit before hydration (or with no JS) still sends the typed email.
  const [state, formAction, pending] = useActionState(sendSignInLinkAction, INITIAL);
  const [dismissed, setDismissed] = useState<SignInLinkState | null>(null);
  const sent = state.status === "sent" && dismissed !== state;
  const linkExpired = linkError === "INVALID_TOKEN" && state.status === "idle";

  return (
    <StorySurface asMain={false}>
      <StoryCard>
        <CardHeader className="text-center">
          <CardTitle className="text-xl font-display">
            {sent ? "Check your email" : "Sign in"}
          </CardTitle>
          <CardDescription className="[overflow-wrap:anywhere]">
            {sent ? `We sent a sign-in link to ${state.email}` : `Sign in to ${storeName}`}
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
          {state.status === "error" && (
            <div
              id="customer-sign-in-error"
              className="mb-4 rounded-md bg-destructive/10 p-3 text-sm text-destructive"
              role="alert"
              aria-live="assertive"
            >
              {state.message}
            </div>
          )}

          {!sent && (
            <form action={formAction} className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor="email">Email address</Label>
                <Input
                  id="email"
                  name="email"
                  type="email"
                  required
                  autoComplete="email"
                  placeholder="you@example.com"
                  defaultValue={state.email}
                  aria-invalid={state.status === "error" ? true : undefined}
                  aria-describedby={state.status === "error" ? "customer-sign-in-error" : undefined}
                />
              </div>

              <Button type="submit" disabled={pending} className="w-full min-h-[44px]">
                {pending ? "Sending..." : "Send sign-in link"}
              </Button>
            </form>
          )}

          {sent && (
            <div className="flex flex-col items-center gap-4 py-2">
              <div className="flex size-12 items-center justify-center rounded-full bg-primary/10">
                <Mail className="size-6" style={{ color: "var(--color-primary-text)" }} />
              </div>
              <p className="text-center text-sm text-muted-foreground">
                Click the link in your email to sign in. The link expires in
                15&nbsp;minutes.
              </p>
              <button
                type="button"
                onClick={() => setDismissed(state)}
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
