import { validateInviteToken } from "@/lib/invite/service";
import { InviteAcceptForm } from "./invite-accept-form";

interface Props {
  params: Promise<{ token: string }>;
}

export default async function InviteAcceptPage({ params }: Props) {
  const { token } = await params;
  const result = await validateInviteToken(token);

  if ("error" in result) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-background p-4">
        <div className="w-full max-w-sm rounded-lg border border-border bg-card p-8 text-center">
          <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-destructive/10">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="size-6 text-destructive"
            >
              <circle cx="12" cy="12" r="10" />
              <line x1="15" y1="9" x2="9" y2="15" />
              <line x1="9" y1="9" x2="15" y2="15" />
            </svg>
          </div>
          <h1 className="mb-2 text-lg font-semibold text-foreground">
            Invalid Invitation
          </h1>
          <p className="text-sm text-muted-foreground">{result.error}</p>
        </div>
      </main>
    );
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background p-4">
      <InviteAcceptForm
        token={token}
        storeName={result.storeName}
        storeSlug={result.storeSlug}
        role={result.role}
        email={result.email}
      />
    </main>
  );
}
