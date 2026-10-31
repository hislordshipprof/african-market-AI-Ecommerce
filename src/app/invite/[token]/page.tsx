import { validateInviteToken } from "@/lib/invite/service";
import { InviteAcceptForm } from "./invite-accept-form";
import { InviteErrorCard } from "./invite-error-card";

interface Props {
  params: Promise<{ token: string }>;
}

export default async function InviteAcceptPage({ params }: Props) {
  const { token } = await params;
  const result = await validateInviteToken(token);

  if ("error" in result) {
    return <InviteErrorCard message={result.error} />;
  }

  return (
    <InviteAcceptForm
      token={token}
      storeName={result.storeName}
      storeSlug={result.storeSlug}
      role={result.role}
      email={result.email}
    />
  );
}
