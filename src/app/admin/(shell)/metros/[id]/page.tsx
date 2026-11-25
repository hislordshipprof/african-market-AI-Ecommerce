import Link from "next/link";
import { notFound } from "next/navigation";
import { getMetro, metroReadiness, METRO_MAX_STATES, METRO_RADIUS_MI, type CourierRegistration } from "@/lib/admin/metros";
import { requirePlatformAdmin } from "@/lib/admin/session";
import { ASSIGNMENT_TIMEOUT_SECONDS, readCourierSettings } from "@/lib/delivery/courier-settings";
import { MetroForm } from "../metro-form";

export const metadata = { title: "Metro readiness" };

const PROVIDER_LABELS = { doordash: "DoorDash Drive", uber: "Uber Direct" } as const;
const REGISTRATION: Record<CourierRegistration, string> = { registered: "Registered", failed: "Failed", not_registered: "Not registered" };
const STATUS: Record<string, string> = { active: "Live", setup: "In setup", suspended: "Suspended" };

function percent(successes: number, attempts: number): string {
  return attempts === 0 ? "No quotes" : `${Math.round((successes / attempts) * 100)}%`;
}

function wait(seconds: number | null): string {
  if (seconds === null) return "No courier assigned yet";
  const whole = Math.round(seconds);
  const m = Math.floor(whole / 60);
  const s = whole % 60;
  return m === 0 ? `${s} s` : s === 0 ? `${m} min` : `${m} min ${s} s`;
}

function Section({ id, title, lede, children }: { id: string; title: string; lede?: string; children: React.ReactNode }) {
  return (
    <section aria-labelledby={id} className="rounded-xl border border-border bg-card p-5">
      <h2 id={id} className="text-base font-semibold text-foreground">{title}</h2>
      {lede && <p className="mt-1 text-sm text-muted-foreground">{lede}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

/** One metro's readiness report and its settings (#577). Platform admin only. */
export default async function MetroPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePlatformAdmin();
  const { id } = await params;
  const metro = await getMetro(id);
  if (!metro) notFound();
  const [report, platform] = await Promise.all([metroReadiness(metro.id), readCourierSettings()]);
  if (!report) notFound();
  const totals = report.quotes.reduce((acc, q) => ({ attempts: acc.attempts + q.attempts, successes: acc.successes + q.successes }), { attempts: 0, successes: 0 });

  return (
    <div className="px-4 py-6 sm:px-6 lg:px-8">
      <p className="text-sm">
        <Link href="/admin/metros" className="font-medium text-primary underline-offset-4 hover:underline">Metros</Link>
      </p>
      <h1 className="mt-2 font-heading text-[28px] font-bold leading-tight text-foreground">{metro.name}</h1>
      <p className="mt-1 text-muted-foreground">
        {metro.states.join(", ")} · {metro.radiusMi} mi around {metro.centerLat}, {metro.centerLng}
      </p>

      <dl className="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-4" aria-label="Summary">
        {[
          { label: "Stores live", value: String(report.counts.live) },
          { label: "Stores in setup", value: String(report.counts.setup) },
          { label: "Quote success, 30 days", value: percent(totals.successes, totals.attempts) },
          { label: "Median wait for a courier", value: wait(report.assignment.medianSeconds) },
        ].map((item) => (
          <div key={item.label} className="rounded-xl border border-border bg-card p-4">
            <dt className="text-sm text-muted-foreground">{item.label}</dt>
            <dd className="mt-1 text-xl font-semibold text-foreground tabular-nums">{item.value}</dd>
          </div>
        ))}
      </dl>

      <div className="mt-6 space-y-6">
        <Section id="stores" title="Stores and courier registration" lede={report.counts.suspended > 0 ? `${report.counts.suspended} suspended.` : undefined}>
          {report.stores.length === 0 ? (
            <p className="text-sm text-muted-foreground">No stores in this metro yet. Add a store from its page under Stores.</p>
          ) : (
            <table className="w-full text-left text-sm">
              <thead className="border-b border-border max-sm:sr-only">
                <tr>
                  <th scope="col" className="py-2 pr-4 font-medium text-muted-foreground">Store</th>
                  <th scope="col" className="py-2 pr-4 font-medium text-muted-foreground">State</th>
                  <th scope="col" className="py-2 pr-4 font-medium text-muted-foreground">{PROVIDER_LABELS.doordash}</th>
                  <th scope="col" className="py-2 font-medium text-muted-foreground">{PROVIDER_LABELS.uber}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {report.stores.map((store) => (
                  <tr key={store.id} className="max-sm:grid max-sm:grid-cols-2 max-sm:gap-x-3 max-sm:gap-y-1 max-sm:py-3" data-testid={`metro-store-${store.id}`}>
                    <td className="py-2 pr-4 align-top max-sm:col-span-2 max-sm:p-0">
                      <Link href={`/admin/stores/${store.id}`} className="font-semibold text-foreground underline-offset-4 hover:underline">{store.name}</Link>
                      <span className="block text-muted-foreground">{[store.city, store.state].filter(Boolean).join(", ") || "No address yet"}</span>
                    </td>
                    <td className="py-2 pr-4 align-top text-foreground max-sm:col-span-2 max-sm:p-0">{STATUS[store.status] ?? store.status}</td>
                    {(["doordash", "uber"] as const).map((provider) => (
                      <td key={provider} className="py-2 pr-4 align-top text-foreground max-sm:p-0">
                        <span className="sm:sr-only text-muted-foreground">{PROVIDER_LABELS[provider]}: </span>
                        <span className={store.couriers[provider] === "registered" ? "" : "font-semibold"}>{REGISTRATION[store.couriers[provider]]}</span>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>

        <Section id="couriers" title="Courier performance, last 30 days" lede="Each courier asked for a quote at checkout or dispatch, and whether it quoted. The wait runs from booking, or the ready time if later, to the courier's assignment.">
          <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-6 gap-y-2 text-sm">
            {(["doordash", "uber"] as const).map((provider) => {
              const row = report.quotes.find((q) => q.provider === provider) ?? { attempts: 0, successes: 0 };
              return (
                <div key={provider} className="contents">
                  <dt className="font-medium text-foreground">{PROVIDER_LABELS[provider]}</dt>
                  <dd className="text-muted-foreground tabular-nums">
                    {percent(row.successes, row.attempts)}
                    {row.attempts > 0 && ` · ${row.successes} of ${row.attempts} quotes`}
                  </dd>
                </div>
              );
            })}
            <dt className="font-medium text-foreground">Median wait</dt>
            <dd className="text-muted-foreground tabular-nums">
              {wait(report.assignment.medianSeconds)}
              {report.assignment.deliveries > 0 && ` · ${report.assignment.deliveries} ${report.assignment.deliveries === 1 ? "delivery" : "deliveries"}`}
            </dd>
          </dl>
        </Section>

        <div className="grid gap-6 md:grid-cols-2">
          <Section id="tax" title="Sales tax sign-off" lede="No real order is taken in a state until the tax advisor signs it off (ADR-0008).">
            <ul className="space-y-2 text-sm">
              {report.taxStates.map((state) => (
                <li key={state.code} className="flex items-baseline justify-between gap-4">
                  <span className="text-foreground">{state.name}</span>
                  <span className={state.signedOff ? "text-muted-foreground" : "font-semibold text-foreground"}>{state.signedOff ? "Signed off" : "Not signed off"}</span>
                </li>
              ))}
            </ul>
          </Section>

          <Section id="pages" title="Directory city pages" lede="A city page shows while a listed, live store with an address is in that city.">
            {report.cityPages.length === 0 ? (
              <p className="text-sm text-muted-foreground">No store here has a city yet.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {report.cityPages.map((page) => (
                  <li key={page.href} className="flex items-baseline justify-between gap-4">
                    <span className="text-foreground">{page.city}, {page.state}</span>
                    {page.present ? (
                      <a href={page.href} className="font-medium text-primary underline-offset-4 hover:underline">Page live</a>
                    ) : (
                      <span className="font-semibold text-foreground">No page</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>
      </div>

      <h2 className="mt-12 text-lg font-semibold text-foreground">Settings</h2>
      <div className="mt-4">
        <MetroForm
          metroId={metro.id}
          metro={metro}
          platform={platform}
          limits={{ radius: METRO_RADIUS_MI, timeout: ASSIGNMENT_TIMEOUT_SECONDS, maxStates: METRO_MAX_STATES }}
        />
      </div>
    </div>
  );
}
