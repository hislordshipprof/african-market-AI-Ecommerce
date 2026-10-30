"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { suspendStore } from "@/lib/admin/actions";

export function SuspendButton({
  storeId,
  currentStatus,
}: {
  storeId: string;
  currentStatus: string;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const isSuspended = currentStatus === "suspended";

  async function handleClick() {
    setLoading(true);
    try {
      await suspendStore(storeId);
      router.refresh();
    } finally {
      setLoading(false);
    }
  }

  return (
    <button
      onClick={handleClick}
      disabled={loading}
      className={`text-sm hover:underline disabled:opacity-50 ${
        isSuspended ? "text-green-700" : "text-red-700"
      }`}
    >
      {loading
        ? "..."
        : isSuspended
          ? "Unsuspend"
          : "Suspend"}
    </button>
  );
}
