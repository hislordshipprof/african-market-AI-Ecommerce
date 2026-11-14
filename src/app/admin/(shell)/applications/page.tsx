import Link from "next/link";
import { requirePlatformAdmin } from "@/lib/admin/session";
import { listStoreApplications } from "@/lib/store-application/service";
import { storeTypeLabel, suggestSlug } from "@/lib/store-application/fields";
import { ApproveForm, RejectForm, ResendRejectionForm } from "./decision-forms";

export const metadata = { title: "Applications — Platform Admin" };
export const dynamic = "force-dynamic";

const dateFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

function offers(pickup: boolean, delivery: boolean): string {
  if (pickup && delivery) return "Pickup and delivery";
  if (pickup) return "Pickup";
  if (delivery) return "Delivery";
  return "Neither yet";
}

export default async function ApplicationsPage() {
  await requirePlatformAdmin();
  const { pending, decided } = await listStoreApplications();
  const domainSuffix = process.env.PLATFORM_ROOT_DOMAIN || null;

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6 lg:py-12">
      <h1 className="font-heading text-[28px] font-bold leading-tight text-foreground">Applications</h1>
      <p className="mt-1 text-muted-foreground">
        {pending.length === 0
          ? "No applications waiting."
          : `${pending.length} ${pending.length === 1 ? "application is" : "applications are"} waiting, oldest first.`}{" "}
        Stores apply on the public /sell page.
      </p>

      {pending.length > 0 && (
        <ul className="mt-8 flex flex-col gap-4" aria-label="Waiting applications">
          {pending.map((application) => (
            <li key={application.id} className="rounded-xl border border-border bg-card p-4 sm:p-5">
              <article aria-labelledby={`app-${application.id}`}>
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <h2 id={`app-${application.id}`} className="font-heading text-lg font-bold text-foreground">
                    {application.businessName}
                  </h2>
                  <span className="text-sm text-muted-foreground">Applied {dateFormat.format(application.createdAt)}</span>
                </div>
                <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
                  <dt className="text-muted-foreground">Kind</dt>
                  <dd className="text-foreground">{storeTypeLabel(application.storeType)}</dd>
                  <dt className="text-muted-foreground">Address</dt>
                  <dd className="text-foreground">
                    {application.addressLine1}, {application.city}, {application.state} {application.zip}
                  </dd>
                  <dt className="text-muted-foreground">Owner</dt>
                  <dd className="break-words text-foreground">
                    {application.ownerName} · <a className="underline" href={`mailto:${application.email}`}>{application.email}</a> ·{" "}
                    <a className="underline" href={`tel:${application.phone}`}>{application.phone}</a>
                  </dd>
                  <dt className="text-muted-foreground">Online</dt>
                  <dd className="break-all text-foreground">
                    {application.website ? (
                      <a className="underline" href={application.website} target="_blank" rel="noopener noreferrer nofollow">
                        {application.website}
                      </a>
                    ) : (
                      "No link given"
                    )}
                  </dd>
                  <dt className="text-muted-foreground">Offers today</dt>
                  <dd className="text-foreground">{offers(application.offersPickup, application.offersDelivery)}</dd>
                </dl>
                <div className="mt-4 flex flex-col gap-4 border-t border-border pt-4">
                  <ApproveForm
                    applicationId={application.id}
                    suggestedSlug={suggestSlug(application.businessName)}
                    domainSuffix={domainSuffix}
                  />
                  <RejectForm applicationId={application.id} />
                </div>
              </article>
            </li>
          ))}
        </ul>
      )}

      <h2 className="mb-3 mt-10 text-sm font-semibold text-muted-foreground">Recently decided</h2>
      {decided.length === 0 ? (
        <p className="rounded-xl border border-border bg-card p-4 text-sm text-muted-foreground">Nothing decided yet.</p>
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
          {decided.map((application) => (
            <li key={application.id} className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
              <span className="min-w-0">
                <span className="block font-medium text-foreground">{application.businessName}</span>
                <span className="block text-sm text-muted-foreground">
                  {application.status === "approved" ? "Approved" : "Rejected"}
                  {application.decidedAt ? ` ${dateFormat.format(application.decidedAt)}` : ""}
                  {application.decidedByEmail ? ` by ${application.decidedByEmail}` : ""}
                  {application.status === "rejected" && application.rejectReason ? ` · ${application.rejectReason}` : ""}
                </span>
              </span>
              {application.status === "approved" && application.store ? (
                <Link href={`/admin/stores/${application.store.id}`} className="shrink-0 text-sm font-medium text-primary underline">
                  Open store
                </Link>
              ) : application.status === "rejected" && !application.rejectionEmailedAt ? (
                <span className="flex shrink-0 flex-col items-start gap-1 sm:items-end">
                  <span className="text-sm text-destructive">Email not sent</span>
                  <ResendRejectionForm applicationId={application.id} />
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
