import { headers } from "next/headers";
import type { ValidatedStore } from "@/lib/get-store";
import { auth } from "@/lib/auth";
import { assistantChatEnabled } from "@/lib/assistant/contract";

export async function AssistantHost({ store }: { store: ValidatedStore }) {
  if (!assistantChatEnabled()) return null;
  const headerList = await headers();
  const session = await auth.api.getSession({ headers: headerList });
  const { AssistantClient } = await import("./assistant-client");
  return (
    <AssistantClient
      storeId={store.id}
      storeStatus={store.status}
      accountId={session?.user?.id ?? null}
    />
  );
}
