"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { copyOwnerInviteLinkAction } from "@/lib/admin/actions";
import type { InviteStatus } from "@/lib/invite/service";

export interface OwnerInviteView {
  email: string;
  status: InviteStatus;
  expiresAt: string;
}

const STATUS_LABEL: Record<InviteStatus, string> = {
  sent: "Email sent",
  failed: "Email not sent",
  copied: "Link copied",
  not_sent: "Not sent yet",
  used: "Used: the owner has joined",
  expired: "Expired",
};

const dateFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC", timeZoneName: "short" });

/**
 * The store's owner invite and where it stands (#839). Copy makes a fresh link, shown here once: the earlier link
 * stops working and the new one is never stored.
 */
export function OwnerInviteStatus({
  storeId,
  invite,
  notEmailedReason,
  renewHint,
}: {
  storeId: string;
  invite: OwnerInviteView;
  notEmailedReason: string;
  renewHint: string;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [link, setLink] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null);
  const open = invite.status !== "used" && invite.status !== "expired";

  function copyLink() {
    setNotice(null);
    startTransition(async () => {
      const result = await copyOwnerInviteLinkAction(storeId);
      if ("error" in result) {
        setLink(null);
        setNotice({ error: true, text: result.error });
        return;
      }
      setLink(result.inviteUrl);
      try {
        await navigator.clipboard.writeText(result.inviteUrl);
        setNotice({ error: false, text: "Link copied. Send it to the owner yourself." });
      } catch {
        setNotice({ error: false, text: "Select the link and copy it, then send it to the owner yourself." });
      }
      router.refresh();
    });
  }

  return (
    <section aria-labelledby={`owner-invite-${storeId}`} className="rounded-lg border border-border bg-card p-5">
      <h2 id={`owner-invite-${storeId}`} className="text-base font-semibold text-foreground">Owner invite</h2>
      <dl className="mt-3 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
        <dt className="font-medium text-foreground">For</dt>
        <dd className="break-words text-muted-foreground">{invite.email}</dd>
        <dt className="font-medium text-foreground">Status</dt>
        <dd data-testid="owner-invite-status" className={invite.status === "failed" ? "text-destructive" : "text-muted-foreground"}>
          {STATUS_LABEL[invite.status]}
          {open && ` · link works until ${dateFormat.format(new Date(invite.expiresAt))}`}
        </dd>
      </dl>
      {invite.status === "failed" && <p className="mt-3 text-sm text-foreground">{notEmailedReason}</p>}
      {open ? (
        <div className="mt-4 flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={copyLink}
              disabled={isPending}
              className="min-h-11 rounded-full border border-primary px-5 text-sm font-medium text-primary hover:bg-secondary disabled:opacity-50"
            >
              {isPending ? "Making a link…" : "Copy invite link"}
            </button>
            <span className="text-sm text-muted-foreground">A new link replaces the one before it.</span>
          </div>
          {link && (
            <input
              readOnly
              aria-label="Invite link"
              value={link}
              onFocus={(e) => e.currentTarget.select()}
              className="block w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs text-foreground"
            />
          )}
        </div>
      ) : (
        <p className="mt-3 text-sm text-muted-foreground">{renewHint}</p>
      )}
      <p role="status" aria-live="polite" className={`mt-2 text-sm ${notice?.error ? "text-destructive" : "text-muted-foreground"}`}>
        {notice?.text}
      </p>
    </section>
  );
}
