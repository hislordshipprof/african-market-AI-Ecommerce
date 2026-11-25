"use client";

import { useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  copyInviteLinkAction,
  inviteMemberAction,
  removeMemberAction,
  resendInviteAction,
  revokeInviteAction,
} from "@/lib/store-admin/actions";
import {
  ArrowLeft,
  UserPlus,
  Mail,
  Trash2,
  Clock,
  AlertTriangle,
  Copy,
} from "lucide-react";

interface Member {
  userId: string;
  name: string;
  email: string;
  role: string;
  readOnly: boolean;
}

interface Invite {
  id: string;
  email: string;
  role: string;
  expiresAt: string;
  emailFailed: boolean;
}

interface Props {
  storeName: string;
  storeSlug: string;
  currentUserId: string;
  members: Member[];
  invites: Invite[];
  /** Staff seats on the plan; null is unlimited. */
  staffSeats: number | null;
}

export function TeamManagement({
  storeName,
  storeSlug,
  currentUserId,
  members,
  invites,
  staffSeats,
}: Props) {
  const seatsUsed = members.filter((m) => m.role !== "owner").length + invites.filter((i) => i.role === "staff").length;
  const seatsFull = staffSeats !== null && seatsUsed >= staffSeats;
  const router = useRouter();
  const searchParams = useSearchParams();
  const storeParam = searchParams.get("store") ?? storeSlug;
  const [isPending, startTransition] = useTransition();
  const [inviteEmail, setInviteEmail] = useState("");
  const [unsent, setUnsent] = useState<{ email: string; warning: string; inviteUrl: string } | null>(null);
  const inviteRole = "staff" as const;

  function afterSave(email: string, result: { warning?: string; inviteUrl?: string }, sent: string) {
    if (result.warning && result.inviteUrl) {
      setUnsent({ email, warning: result.warning, inviteUrl: result.inviteUrl });
    } else {
      setUnsent(null);
      toast.success(sent);
    }
    router.refresh();
  }

  function handleResend(invite: Invite) {
    startTransition(async () => {
      const result = await resendInviteAction(invite.id);
      if ("error" in result) {
        toast.error(result.error);
      } else {
        afterSave(invite.email, result, `Invitation sent again to ${invite.email}`);
      }
    });
  }

  function handleCopy(invite: Invite) {
    startTransition(async () => {
      const result = await copyInviteLinkAction(invite.id);
      if ("error" in result) {
        toast.error(result.error);
        return;
      }
      setUnsent({ email: invite.email, warning: "New invite link made. The earlier link no longer works.", inviteUrl: result.inviteUrl });
      await copyLink(result.inviteUrl);
      router.refresh();
    });
  }

  function handleRevoke(invite: Invite) {
    startTransition(async () => {
      const result = await revokeInviteAction(invite.id);
      if ("error" in result && result.error) {
        toast.error(result.error);
      } else {
        if (unsent?.email === invite.email) setUnsent(null);
        toast.success(`Invitation to ${invite.email} revoked`);
        router.refresh();
      }
    });
  }

  async function copyLink(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Link copied");
    } catch {
      toast.error("Could not copy. Select the link and copy it.");
    }
  }

  function handleInvite(e: React.FormEvent) {
    e.preventDefault();
    const formData = new FormData();
    formData.set("email", inviteEmail);
    formData.set("role", inviteRole);

    startTransition(async () => {
      const result = await inviteMemberAction(formData);
      if ("error" in result) {
        toast.error(result.error);
      } else {
        afterSave(inviteEmail, result, `Invitation sent to ${inviteEmail}`);
        setInviteEmail("");
      }
    });
  }

  function handleRemove(userId: string, name: string) {
    startTransition(async () => {
      const result = await removeMemberAction(userId);
      if ("error" in result && result.error) {
        toast.error(result.error);
      } else {
        toast.success(`${name} has been removed`);
        router.refresh();
      }
    });
  }

  return (
    <div className="min-h-dvh bg-background">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-2xl items-center gap-3 px-4 py-3">
          <Link href={`/store-admin?store=${storeParam}`}>
            <Button variant="ghost" size="icon" className="size-9">
              <ArrowLeft className="size-4" />
            </Button>
          </Link>
          <div>
            <h1 className="text-base font-semibold text-foreground">Team</h1>
            <p className="text-xs text-muted-foreground">{storeName}</p>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-2xl px-4 py-6">
        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <UserPlus className="size-5 text-primary" />
                <CardTitle className="text-base">Invite a team member</CardTitle>
              </div>
              <CardDescription>
                {staffSeats === null
                  ? "Send an invitation to join this store"
                  : `${Math.min(seatsUsed, staffSeats)} of ${staffSeats} staff seats used on the Starter plan`}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {seatsFull ? (
                <p className="text-sm text-foreground">
                  The Starter plan includes the owner and {staffSeats} staff.{" "}
                  <Link href={`/store-admin/plan?store=${storeParam}`} className="font-medium text-primary underline underline-offset-4">
                    Upgrade to Pro
                  </Link>{" "}
                  for unlimited staff, or remove someone to free a seat.
                </p>
              ) : (
              <form
                onSubmit={handleInvite}
                className="flex flex-col gap-4 sm:flex-row sm:items-end"
              >
                <div className="flex flex-1 flex-col gap-2">
                  <Label htmlFor="invite-email">Email address</Label>
                  <Input
                    id="invite-email"
                    type="email"
                    required
                    value={inviteEmail}
                    onChange={(e) => setInviteEmail(e.target.value)}
                    placeholder="team@example.com"
                  />
                </div>

                <Button type="submit" disabled={isPending}>
                  <Mail className="size-4" data-icon="inline-start" />
                  {isPending ? "Sending..." : "Send invite"}
                </Button>
              </form>
              )}
              {unsent && (
                <div role="status" className="mt-4 flex flex-col gap-3 rounded-lg border border-border bg-muted/50 p-3">
                  <p className="flex items-start gap-2 text-sm text-foreground">
                    <AlertTriangle className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span>
                      {unsent.warning}{" "}
                      <span className="text-muted-foreground">Invite for {unsent.email}.</span>
                    </span>
                  </p>
                  <div className="flex gap-2">
                    <Input
                      readOnly
                      aria-label={`Invite link for ${unsent.email}`}
                      value={unsent.inviteUrl}
                      onFocus={(e) => e.currentTarget.select()}
                      className="min-w-0 flex-1 text-xs"
                    />
                    <Button type="button" variant="outline" onClick={() => copyLink(unsent.inviteUrl)}>
                      <Copy className="size-4" data-icon="inline-start" />
                      Copy link
                    </Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Members</CardTitle>
              <CardDescription>
                {members.length} member{members.length !== 1 ? "s" : ""}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex flex-col divide-y divide-border">
                {members.map((member) => (
                  <div
                    key={member.userId}
                    className="flex items-center justify-between py-3 first:pt-0 last:pb-0"
                  >
                    <div className="flex flex-col gap-0.5">
                      <span className="text-sm font-medium text-foreground">
                        {member.name}
                        {member.userId === currentUserId && (
                          <span className="ml-1.5 text-xs text-muted-foreground">
                            (you)
                          </span>
                        )}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {member.email}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      {member.readOnly && <Badge variant="outline">Read-only</Badge>}
                      <Badge variant="secondary">{member.role}</Badge>
                      {member.userId !== currentUserId && (
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Remove ${member.name}`}
                          className="size-8 text-destructive hover:bg-destructive/10 hover:text-destructive"
                          onClick={() =>
                            handleRemove(member.userId, member.name)
                          }
                          disabled={isPending}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          {invites.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Pending invitations</CardTitle>
                <CardDescription>
                  {invites.length} pending invite
                  {invites.length !== 1 ? "s" : ""}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex flex-col divide-y divide-border">
                  {invites.map((invite) => (
                    <div
                      key={invite.id}
                      className="flex flex-wrap items-center justify-between gap-2 py-3 first:pt-0 last:pb-0"
                    >
                      <div className="flex flex-col gap-0.5">
                        <span className="text-sm font-medium text-foreground">
                          {invite.email}
                        </span>
                        <span className="flex items-center gap-1 text-xs text-muted-foreground">
                          <Clock className="size-3" />
                          Expires{" "}
                          {new Date(invite.expiresAt).toLocaleDateString()}
                        </span>
                        {invite.emailFailed && (
                          <span className="text-xs text-destructive">Email not sent</span>
                        )}
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="outline">{invite.role}</Badge>
                        <Button
                          variant="outline"
                          size="sm"
                          aria-label={`Resend invite to ${invite.email}`}
                          onClick={() => handleResend(invite)}
                          disabled={isPending}
                        >
                          Resend
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          aria-label={`Copy invite link for ${invite.email}`}
                          onClick={() => handleCopy(invite)}
                          disabled={isPending}
                        >
                          <Copy className="size-4" data-icon="inline-start" />
                          Copy link
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={`Revoke invite to ${invite.email}`}
                          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                          onClick={() => handleRevoke(invite)}
                          disabled={isPending}
                        >
                          Revoke
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </main>
    </div>
  );
}
