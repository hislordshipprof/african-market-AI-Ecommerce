"use client";

import { useState, useTransition } from "react";
import { inviteStoreOwnerAction } from "@/lib/admin/actions";

interface Props {
  storeId: string;
}

export function InviteOwnerForm({ storeId }: Props) {
  const [email, setEmail] = useState("");
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setMessage(null);
    const formData = new FormData();
    formData.set("storeId", storeId);
    formData.set("email", email);

    startTransition(async () => {
      const result = await inviteStoreOwnerAction(formData);
      if ("error" in result && result.error) {
        setMessage({ type: "error", text: result.error });
      } else {
        setMessage({ type: "success", text: `Owner invitation sent to ${email}` });
        setEmail("");
      }
    });
  }

  return (
    <div className="rounded-lg border border-[#D1D5C8] bg-white p-6">
      <h2 className="mb-2 text-lg font-semibold text-[#15201A]">Invite Store Owner</h2>
      <p className="mb-4 text-sm text-[#55625A]">
        Send an invitation to the store owner to set up their account.
      </p>
      {message && (
        <div
          className={`mb-4 rounded-md p-3 text-sm ${
            message.type === "success"
              ? "bg-green-50 text-green-800"
              : "bg-red-50 text-red-800"
          }`}
        >
          {message.text}
        </div>
      )}
      <form onSubmit={handleSubmit} className="flex gap-3">
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="owner@example.com"
          className="flex-1 rounded-md border border-[#D1D5C8] bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#1F5A43]"
        />
        <button
          type="submit"
          disabled={isPending}
          className="rounded-md bg-[#1F5A43] px-4 py-2 text-sm font-medium text-white hover:bg-[#174432] disabled:opacity-50"
        >
          {isPending ? "Sending..." : "Send Invite"}
        </button>
      </form>
    </div>
  );
}
