import { Check, Minus } from "lucide-react";
import { PLAN_NAMES, PLAN_PRICES_USD, PLANS, planComparisonRows, type Plan } from "@/lib/billing/plan";

/**
 * Starter vs Pro, built only from the plan module (#838). /sell and the store-admin plan page both render this;
 * no other page lists plan features.
 */
export function PlanComparison({ currentPlan, offer }: { currentPlan?: Plan; offer?: string }) {
  return (
    <section id="plans" aria-labelledby="plans-title" className="scroll-mt-6 rounded-xl border border-border bg-card p-4 sm:p-5">
      <h2 id="plans-title" className="text-lg font-semibold text-foreground">
        What each plan gives
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">No commission on your sales on either plan. Change or cancel any time.</p>
      {offer && (
        <p className="mt-3 rounded-lg bg-primary/10 px-3 py-2 text-sm font-medium text-foreground" data-testid="pilot-offer">
          {offer}
        </p>
      )}
      <table className="mt-4 w-full table-fixed border-collapse text-sm">
        <caption className="sr-only">Starter and Pro compared</caption>
        <colgroup>
          <col />
          <col className="w-[27%] sm:w-[22%]" />
          <col className="w-[27%] sm:w-[22%]" />
        </colgroup>
        <thead>
          <tr className="border-b border-border">
            <td />
            {PLANS.map((plan) => (
              <th key={plan} scope="col" className="px-1.5 pb-3 text-left align-top font-normal sm:px-3">
                <span className="block text-base font-semibold text-foreground">{PLAN_NAMES[plan]}</span>
                <span className="block tabular-nums text-foreground">
                  <span className="text-lg font-semibold">${PLAN_PRICES_USD[plan]}</span>
                  <span className="text-muted-foreground"> / month</span>
                </span>
                {plan === currentPlan && (
                  <span className="mt-1 inline-block rounded-full bg-primary px-2 py-0.5 text-xs font-medium text-primary-foreground">
                    Your plan
                  </span>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {planComparisonRows().map((row) => (
            <tr key={row.label} className="border-b border-border last:border-b-0">
              <th scope="row" className="py-2.5 pr-2 text-left align-top font-normal text-foreground">
                {row.label}
                {row.comingSoon && <span className="text-muted-foreground"> (coming soon)</span>}
              </th>
              {PLANS.map((plan) => (
                <td key={plan} className="px-1.5 py-2.5 align-top text-foreground sm:px-3">
                  <Value value={row[plan]} plan={plan} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/** Included or not is an icon plus words for screen readers, never colour alone (DESIGN.md). */
function Value({ value, plan }: { value: boolean | string; plan: Plan }) {
  if (typeof value === "string") return <span className="break-words">{value}</span>;
  return value ? (
    <>
      <Check className="size-5 text-primary" aria-hidden />
      <span className="sr-only">Included on {PLAN_NAMES[plan]}</span>
    </>
  ) : (
    <>
      <Minus className="size-5 text-muted-foreground" aria-hidden />
      <span className="sr-only">Not included on {PLAN_NAMES[plan]}</span>
    </>
  );
}
