import { headers } from "next/headers";
import type { ValidatedStore } from "@/lib/get-store";
import { auth } from "@/lib/auth";
import { assistantChatEnabled } from "@/lib/assistant/contract";
import { assistantAccountId } from "@/lib/assistant/ui/account-id";

export async function AssistantHost({ store }: { store: ValidatedStore }) {
  if (!assistantChatEnabled()) return null;
  const accountId = await assistantAccountId(async () => {
    const headerList = await headers();
    return auth.api.getSession({ headers: headerList });
  });
  const { AssistantClient } = await import("./assistant-client");
  return (
    <AssistantClient
      storeId={store.id}
      storeStatus={store.status}
      accountId={accountId}
    />
  );
}
