"use client";

import { useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { adminDisconnectStoreNumberAction, adminLinkStoreNumberAction } from "@/lib/whatsapp/store-number-actions";

interface Props {
  storeId: string;
  mode: "form" | "meta" | "unavailable";
  number: {
    status: "pending" | "registered" | "failed" | "disconnected";
    wabaId: string;
    phoneNumberId: string;
    displayNumber: string | null;
    coexistence: boolean;
    failureCode: string | null;
  } | null;
}

const STATUS_LABEL = {
  pending: "Linking did not finish",
  registered: "Live",
  failed: "Failed",
  disconnected: "Disconnected",
} as const;

const inputClass =
  "min-h-11 w-full rounded-md border border-[#D1D5C8] bg-white px-3 text-base text-[#15201A] focus:outline-none focus:ring-2 focus:ring-[#1F5A43]";

export function WhatsAppNumberSection({ storeId, mode, number }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const live = number?.status === "registered";

  function run(action: (form: FormData) => Promise<{ ok: true } | { error: string }>, form: FormData) {
    form.set("storeId", storeId);
    setError(null);
    startTransition(async () => {
      const result = await action(form);
      if ("error" in result) setError(result.error);
      else router.refresh();
    });
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    run(adminLinkStoreNumberAction, new FormData(event.currentTarget));
  }

  return (
    <section aria-labelledby="store-whatsapp" className="mb-8 rounded-lg border border-[#e2e4e9] bg-white p-5">
      <h2 id="store-whatsapp" className="text-base font-semibold text-[#15201A]">Store WhatsApp number</h2>
      <p className="mt-1 text-sm text-[#55625A]">Customers message this number to reach the store.</p>
      {number ? (
        <dl className="mt-3 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
          <dt className="font-medium text-[#15201A]">Status</dt>
          <dd className="text-[#55625A]">
            {STATUS_LABEL[number.status]}
            {number.failureCode && number.status === "failed" ? ` · code ${number.failureCode}` : ""}
          </dd>
          <dt className="font-medium text-[#15201A]">Number</dt>
          <dd className="break-words text-[#55625A]">{number.displayNumber ?? "Not known yet"}</dd>
          <dt className="font-medium text-[#15201A]">Phone number ID</dt>
          <dd className="break-words text-[#55625A]">{number.phoneNumberId}</dd>
          <dt className="font-medium text-[#15201A]">WABA ID</dt>
          <dd className="break-words text-[#55625A]">{number.wabaId}</dd>
          <dt className="font-medium text-[#15201A]">Business app</dt>
          <dd className="text-[#55625A]">{number.coexistence ? "Shared (coexistence)" : "API only"}</dd>
        </dl>
      ) : (
        <p className="mt-3 text-sm text-[#55625A]">No number linked.</p>
      )}

      {mode === "unavailable" && !live && (
        <p className="mt-4 text-sm text-[#55625A]">WhatsApp keys are not set, so a number cannot be linked.</p>
      )}
      {mode === "meta" && !live && (
        <p className="mt-4 text-sm text-[#55625A]">Embedded Signup is not built yet; numbers link in test mode only.</p>
      )}

      {mode === "form" && !live && (
        <form onSubmit={onSubmit} className="mt-4 space-y-3">
          <p className="text-xs text-[#55625A]">Test mode: enter the ids from Meta&apos;s Embedded Signup.</p>
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="block text-sm font-medium text-[#15201A]">
              WABA ID
              <input name="wabaId" inputMode="numeric" required maxLength={20} className={`mt-1 ${inputClass}`} disabled={pending} />
            </label>
            <label className="block text-sm font-medium text-[#15201A]">
              Phone number ID
              <input name="phoneNumberId" inputMode="numeric" required maxLength={20} className={`mt-1 ${inputClass}`} disabled={pending} />
            </label>
            <label className="block text-sm font-medium text-[#15201A]">
              WhatsApp number
              <input name="displayNumber" type="tel" required maxLength={32} placeholder="+14045550123" className={`mt-1 ${inputClass}`} disabled={pending} />
            </label>
          </div>
          <label className="flex min-h-11 items-center gap-3 text-sm text-[#15201A]">
            <input type="checkbox" name="coexistence" defaultChecked className="size-5 accent-[#1F5A43]" disabled={pending} />
            Keep the WhatsApp Business app on this number (coexistence)
          </label>
          <button
            type="submit"
            disabled={pending}
            className="min-h-11 rounded-full bg-[#1F5A43] px-5 text-sm font-medium text-white hover:bg-[#184935] disabled:opacity-60"
          >
            {pending ? "Linking…" : "Link number"}
          </button>
        </form>
      )}

      {number && number.status !== "disconnected" && (
        <button
          type="button"
          disabled={pending}
          onClick={() => run(adminDisconnectStoreNumberAction, new FormData())}
          className="mt-4 min-h-11 rounded-full border border-[#B42318] px-5 text-sm font-medium text-[#B42318] hover:bg-[#FEF3F2] disabled:opacity-60"
        >
          Disconnect number
        </button>
      )}

      {error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
    </section>
  );
}
