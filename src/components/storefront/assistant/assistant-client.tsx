"use client";

import dynamic from "next/dynamic";

const AssistantLauncher = dynamic(
  () => import("./assistant-launcher").then((mod) => mod.AssistantLauncher),
  { ssr: false },
);

export function AssistantClient(props: {
  storeId: string;
  storeName: string;
  storeStatus: string;
  accountId: string | null;
}) {
  return <AssistantLauncher {...props} />;
}
