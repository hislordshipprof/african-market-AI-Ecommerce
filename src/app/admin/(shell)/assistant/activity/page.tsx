import Link from "next/link";
import { listAssistantActivity } from "@/lib/admin/assistant/activity";

export const metadata = { title: "Assistant activity" };

const when = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" });
const ID = /^[A-Za-z0-9_-]{1,200}$/;

/** Every assistant tool call, card, confirm, reject, stale card and refusal from AuditLog, newest first (#834). */
export default async function AssistantActivityPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const adminId = typeof params.admin === "string" && ID.test(params.admin) ? params.admin : undefined;
  const beforeRaw = typeof params.before === "string" ? new Date(params.before) : null;
  const before = beforeRaw && !Number.isNaN(beforeRaw.getTime()) ? beforeRaw : undefined;
  const { rows, more, admins } = await listAssistantActivity({ adminId, before });
  const last = rows.at(-1);
  const older = last ? `/admin/assistant/activity?${new URLSearchParams({ ...(adminId ? { admin: adminId } : {}), before: last.at.toISOString() })}` : null;

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <p className="text-base">
        <Link href="/admin?assistant=open" className="font-semibold text-foreground underline underline-offset-4">Assistant</Link>
      </p>
      <h1 className="mt-2 text-2xl font-bold text-foreground">Assistant activity</h1>
      <p className="mt-2 max-w-[65ch] text-base leading-6 text-muted-foreground">
        Every question the assistant looked up, every card it drafted, and every confirm and dismiss, from the audit log. Newest first. Times are UTC.
      </p>

      <form method="get" className="mt-6 flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor="activity-admin" className="block text-sm font-medium text-foreground">Admin</label>
          <select
            id="activity-admin"
            name="admin"
            defaultValue={adminId ?? ""}
            className="mt-1 min-h-11 rounded-md border border-border bg-card px-3 text-base text-foreground focus-visible:outline-2 focus-visible:outline-ring"
          >
            <option value="">Every admin</option>
            {admins.map((admin) => <option key={admin.id} value={admin.id}>{admin.email}</option>)}
          </select>
        </div>
        <button type="submit" className="min-h-11 rounded-full border border-border bg-card px-5 text-sm font-medium text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
          Show
        </button>
      </form>

      {rows.length === 0 ? (
        <p className="mt-6 rounded-xl border border-border bg-card px-4 py-5 text-base text-muted-foreground">No assistant activity{adminId ? " for this admin" : ""} yet.</p>
      ) : (
        <ul className="mt-6 flex flex-col divide-y divide-border rounded-xl border border-border bg-card">
          {rows.map((row) => (
            <li key={row.id} className="px-4 py-3">
              <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="text-base font-semibold text-foreground">{row.what}</span>
                {row.name ? <span className="font-mono text-sm text-foreground">{row.name}</span> : null}
                <time dateTime={row.at.toISOString()} className="ml-auto text-sm text-muted-foreground tabular-nums">{when.format(row.at)}</time>
              </p>
              <p className="mt-0.5 break-all text-sm text-muted-foreground">{row.adminEmail}</p>
              {row.detail ? <p className="mt-1 break-words font-mono text-[0.8125rem] leading-5 text-foreground">{row.detail}</p> : null}
            </li>
          ))}
        </ul>
      )}
      {more && older ? (
        <p className="mt-4">
          <Link href={older} className="inline-flex min-h-11 items-center font-semibold text-foreground underline underline-offset-4">Older activity</Link>
        </p>
      ) : null}
    </div>
  );
}
