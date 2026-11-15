import { TriangleAlert } from "lucide-react";
import { formatAiUsd, loadAiEvalSpend, type EvalView, type SpendDay, type StoreChatUsage } from "@/lib/admin/ai-eval-spend";
import { requirePlatformAdmin } from "@/lib/admin/session";
import { PLAN_NAMES } from "@/lib/billing/plan";

export const metadata = { title: "AI eval and spend — Platform Admin" };

const VERDICT_TEXT: Record<EvalView["verdict"], string> = {
  "haiku-ok": "Haiku OK",
  "sonnet-candidate": "Sonnet candidate",
};

const percent = (rate: number) => `${(rate * 100).toFixed(1)}%`;

const utc = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-US", { ...options, timeZone: "UTC" });
const finishedFormat = utc({ month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
const dayFormat = utc({ weekday: "short", month: "short", day: "numeric", year: "numeric" });
const monthFormat = utc({ month: "long", year: "numeric" });

export default async function AiEvalSpendPage() {
  await requirePlatformAdmin();
  const data = await loadAiEvalSpend();
  const { spend } = data;

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 lg:py-12">
      <h1 className="font-heading text-[28px] font-bold leading-tight text-foreground">AI eval and spend</h1>
      <p className="mt-1 max-w-prose text-muted-foreground" data-testid="assistant-state">
        {spend.resting
          ? `The shopping assistant is resting: ${formatAiUsd(spend.spentMicros)} spent of the ${formatAiUsd(spend.capMicros)} cap.`
          : `The shopping assistant is on: ${formatAiUsd(spend.spentMicros)} spent of the ${formatAiUsd(spend.capMicros)} cap.`}
      </p>

      <EvalSection view={data.eval} />
      <SpendSection spentMicros={spend.spentMicros} capMicros={spend.capMicros} resting={spend.resting} days={spend.days} />
      <ChatsSection month={data.chats.month} stores={data.chats.stores} hidden={data.chats.hidden} />
    </div>
  );
}

function SectionHeading({ id, title, children }: { id: string; title: string; children?: React.ReactNode }) {
  return (
    <div className="mb-3">
      <h2 id={id} className="text-lg font-semibold text-foreground">{title}</h2>
      {children && <p className="mt-0.5 max-w-prose text-sm text-muted-foreground">{children}</p>}
    </div>
  );
}

function EvalSection({ view }: { view: EvalView | null }) {
  if (!view) {
    return (
      <section className="mt-10" aria-labelledby="eval-title" data-testid="eval">
        <SectionHeading id="eval-title" title="Shopper assistant eval" />
        <p className="rounded-xl border border-border bg-card p-6 text-muted-foreground">
          No readable eval report is committed. Run the #146 eval on the command line to make one.
        </p>
      </section>
    );
  }
  const reasons = [...new Set(view.runs.flatMap((run) => run.verdictReasons))];
  const rows: Array<{ label: string; floor?: string; runs: string[]; result: string; testId: string }> = [
    { label: "List precision", floor: "Floor 90%", runs: view.runs.map((run) => percent(run.precision)), result: percent(view.average.precision), testId: "precision" },
    { label: "List recall", floor: "Floor 85%", runs: view.runs.map((run) => percent(run.recall)), result: percent(view.average.recall), testId: "recall" },
    {
      label: "Dish pass rate",
      floor: "Floor 85%",
      runs: view.runs.map((run) => `${percent(run.dishPassRate)} (${run.dishPassed}/${run.dishCases})`),
      result: percent(view.average.dishPassRate),
      testId: "dish",
    },
    { label: "Made-up items", floor: "Must be 0", runs: view.runs.map((run) => String(run.madeUpItems)), result: String(view.madeUpItems), testId: "made-up" },
    { label: "Verdict", runs: view.runs.map((run) => VERDICT_TEXT[run.verdict]), result: VERDICT_TEXT[view.verdict], testId: "verdict" },
    { label: "Cost", runs: view.runs.map((run) => formatAiUsd(run.costMicros)), result: formatAiUsd(view.costMicros), testId: "cost" },
  ];

  return (
    <section className="mt-10" aria-labelledby="eval-title" data-testid="eval">
      <SectionHeading id="eval-title" title="Shopper assistant eval">
        The committed #146 report. Live runs start only from the command line.
      </SectionHeading>
      <div className="rounded-xl border border-border bg-card">
        <dl className="grid gap-x-6 gap-y-3 border-b border-border p-4 text-sm sm:grid-cols-3 sm:p-5">
          <div>
            <dt className="text-muted-foreground">Model</dt>
            <dd className="font-medium text-foreground" data-testid="eval-model" translate="no">{view.models.join(", ")}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Finished</dt>
            <dd className="font-medium text-foreground" data-testid="eval-date">
              <time dateTime={view.finishedAt}>{finishedFormat.format(new Date(view.finishedAt))} UTC</time>
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Verdict</dt>
            <dd className="font-medium text-foreground">{VERDICT_TEXT[view.verdict]}</dd>
          </div>
        </dl>
        <table className="w-full text-sm" data-testid="eval-table">
          <caption className="sr-only">Eval figures for each run and the two-run result</caption>
          <thead>
            <tr className="border-b border-border text-left text-muted-foreground">
              <th scope="col" className="px-4 py-2 font-medium sm:px-5">Measure</th>
              {view.runs.map((_, index) => (
                <th key={index} scope="col" className="px-2 py-2 text-right font-medium">Run {index + 1}</th>
              ))}
              <th scope="col" className="px-4 py-2 text-right font-medium sm:px-5">Result</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((row) => (
              <tr key={row.label} data-testid={`eval-${row.testId}`}>
                <th scope="row" className="px-4 py-3 text-left font-normal sm:px-5">
                  <span className="block text-foreground">{row.label}</span>
                  {row.floor && <span className="block text-xs text-muted-foreground">{row.floor}</span>}
                </th>
                {row.runs.map((value, index) => (
                  <td key={index} className="px-2 py-3 text-right tabular-nums text-foreground">{value}</td>
                ))}
                <td className="px-4 py-3 text-right font-semibold tabular-nums text-foreground sm:px-5">{row.result}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="border-t border-border p-4 text-sm text-muted-foreground sm:p-5">
          <p>Rates in Result are averaged over the runs, as the CI gate reads them. Made-up items and cost are totals.</p>
          {reasons.length > 0 && (
            <p className="mt-2" data-testid="eval-reasons">
              Not Haiku OK because {reasons.join("; ")}.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

function SpendSection({ spentMicros, capMicros, resting, days }: { spentMicros: bigint; capMicros: bigint; resting: boolean; days: SpendDay[] }) {
  const used = capMicros > BigInt(0) ? Math.min(Number((spentMicros * BigInt(1000)) / capMicros) / 10, 100) : 100;

  return (
    <section className="mt-10" aria-labelledby="spend-title" data-testid="spend">
      <SectionHeading id="spend-title" title="Platform AI spend">
        Every AI call the app makes, from the shopping assistant to the copilot and evals, measured from token usage. At the cap the assistant rests and the storefront keeps working.
      </SectionHeading>
      <div className="rounded-xl border border-border bg-card p-4 sm:p-5">
        <p className="flex flex-wrap items-baseline gap-x-2 text-foreground">
          <span className="font-heading text-[28px] font-bold leading-none tabular-nums" data-testid="spend-total">{formatAiUsd(spentMicros)}</span>
          <span className="text-muted-foreground">of the {formatAiUsd(capMicros)} cap</span>
          {resting && (
            <span className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-0.5 text-sm font-medium">
              <TriangleAlert aria-hidden className="size-4" /> Resting
            </span>
          )}
        </p>
        <div
          role="meter"
          aria-label="Spend against the cap"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={used}
          aria-valuetext={`${used}% of the cap`}
          className="mt-4 h-2 overflow-hidden rounded-full bg-muted"
        >
          <div className="h-full rounded-full bg-foreground" style={{ width: `${used}%` }} />
        </div>
        <p className="mt-3 text-sm text-muted-foreground">The cap counts every day since the ledger started, not only the days listed below.</p>
      </div>

      <h3 className="mb-2 mt-6 text-sm font-semibold text-muted-foreground">By UTC day, last 30 days</h3>
      {days.length === 0 ? (
        <p className="rounded-xl border border-border bg-card p-6 text-muted-foreground">No AI spend in the last 30 days.</p>
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card" data-testid="spend-days">
          {days.map((day) => (
            <li key={day.day} className="flex min-h-12 flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-sm sm:px-5" data-testid={`spend-day-${day.day}`}>
              <time dateTime={day.day} className="flex-1 text-foreground">{dayFormat.format(new Date(`${day.day}T00:00:00Z`))}</time>
              {day.capAlerted && <span className="rounded-full border border-border px-2 py-0.5 text-xs font-medium text-foreground">Cap reached</span>}
              <span className="font-medium tabular-nums text-foreground">{formatAiUsd(day.costMicros)}</span>
            </li>
          ))}
        </ul>
      )}
      {days.length > 0 && <p className="mt-2 text-sm text-muted-foreground">Days with no spend are left out.</p>}
    </section>
  );
}

function ChatsSection({ month, stores, hidden }: { month: string; stores: StoreChatUsage[]; hidden: number }) {
  return (
    <section className="mt-10" aria-labelledby="chats-title" data-testid="chats">
      <SectionHeading id="chats-title" title={`Assistant chats in ${monthFormat.format(new Date(`${month}T00:00:00Z`))}`}>
        Each store against its plan&apos;s monthly chats (UTC month). Stores at 80% or more are marked; that is when the owner gets an email.
      </SectionHeading>
      {stores.length === 0 ? (
        <p className="rounded-xl border border-border bg-card p-6 text-muted-foreground">No store has used the assistant this month.</p>
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
          {stores.map((store) => (
            <li key={store.storeId} className="flex min-h-16 flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 sm:px-5" data-testid={`chats-${store.storeId}`}>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-foreground">{store.storeName}</span>
                <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
                  {PLAN_NAMES[store.plan]} plan
                  {store.nearCap && (
                    <span className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs font-medium text-foreground" data-testid="near-cap">
                      <TriangleAlert aria-hidden className="size-3.5" />
                      {store.atCap ? "At cap" : "80% or more"}
                    </span>
                  )}
                </span>
              </span>
              <span className="text-right tabular-nums">
                <span className="block font-medium text-foreground">
                  {store.chats.toLocaleString("en-US")} of {store.cap.toLocaleString("en-US")}
                </span>
                <span className="block text-sm text-muted-foreground">{Math.floor((store.chats / store.cap) * 100)}%</span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {hidden > 0 && (
        <p className="mt-2 text-sm text-muted-foreground">
          {hidden} more {hidden === 1 ? "store" : "stores"} under 80% not shown.
        </p>
      )}
    </section>
  );
}
