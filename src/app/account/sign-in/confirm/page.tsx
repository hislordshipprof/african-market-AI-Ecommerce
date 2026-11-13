import type { Metadata } from "next";
import { StorefrontShell } from "@/components/storefront/storefront-shell";
import { StoryCard, StorySurface } from "@/components/story-surface/story-surface";
import { CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { getStore } from "@/lib/get-store";

export const metadata: Metadata = {
  title: "Finish signing in",
  robots: { index: false, follow: false },
};

const relative = (value: string | undefined) =>
  value && value.startsWith("/") && !value.startsWith("//") ? value : "/account";

/**
 * The emailed sign-in link lands here. Only the Continue button (a form, which link
 * scanners do not submit) opens the one-time verify URL.
 */
export default async function ConfirmSignInPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; callbackURL?: string }>;
}) {
  const [store, params] = await Promise.all([getStore(), searchParams]);
  const token = params.token ?? "";
  return (
    <StorefrontShell store={store}>
      <StorySurface asMain={false}>
        <StoryCard>
          <CardHeader className="text-center">
            <CardTitle className="text-xl font-display">Finish signing in</CardTitle>
            <CardDescription>
              {token ? `Continue to sign in to ${store.name}.` : "This sign-in link is incomplete. Send a new one."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {token ? (
              <form method="get" action="/api/auth/magic-link/verify">
                <input type="hidden" name="token" value={token} />
                <input type="hidden" name="callbackURL" value={relative(params.callbackURL)} />
                <Button type="submit" className="w-full min-h-[44px]">
                  Continue
                </Button>
              </form>
            ) : (
              <a href="/account/sign-in" className="flex min-h-[44px] items-center justify-center text-sm underline underline-offset-4">
                Send a new link
              </a>
            )}
          </CardContent>
        </StoryCard>
      </StorySurface>
    </StorefrontShell>
  );
}
