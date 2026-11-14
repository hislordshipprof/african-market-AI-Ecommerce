import { ChevronDown } from "lucide-react";
import { reportSections, weekLabel, type WeeklyReportView } from "@/lib/copilot/weekly-report";

function Report({ report, open }: { report: WeeklyReportView; open: boolean }) {
  return (
    <details open={open} className="group">
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-4 [&::-webkit-details-marker]:hidden text-base font-semibold text-foreground">
        <span>{weekLabel(report.figures)}</span>
        <span className="flex items-center gap-2 text-sm font-normal text-muted-foreground">
          {report.isoWeek}
          <ChevronDown aria-hidden className="size-4 transition-transform group-open:rotate-180 motion-reduce:transition-none" />
        </span>
      </summary>
      <div className="flex flex-col gap-4 px-4 pt-1 pb-4">
        {reportSections(report.figures).map((section) => (
          <div key={section.title}>
            <h3 className="text-sm font-semibold text-foreground">{section.title}</h3>
            {section.lines.length === 0 ? (
              <p className="mt-1 text-sm text-muted-foreground">{section.empty}</p>
            ) : (
              <ul className="mt-1 flex flex-col gap-0.5 text-sm text-muted-foreground tabular-nums">
                {section.lines.map((line) => <li key={line}>{line}</li>)}
              </ul>
            )}
          </div>
        ))}
      </div>
    </details>
  );
}

export function WeeklyReports({ reports }: { reports: WeeklyReportView[] }) {
  return (
    <section aria-labelledby="weekly-reports-title" className="mt-8 flex flex-col gap-3">
      <div>
        <h2 id="weekly-reports-title" className="font-display text-[1.375rem] leading-tight font-bold text-balance text-foreground">
          Weekly reports
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Emailed to owners every Monday at the digest hour: last week, Monday to Sunday store time, against the week before.
        </p>
      </div>
      {reports.length === 0 ? (
        <p className="rounded-xl border border-border bg-card px-4 py-4 text-base text-muted-foreground">
          Your first weekly report arrives next Monday.
        </p>
      ) : (
        <div className="divide-y divide-border rounded-xl border border-border bg-card">
          {reports.map((report, index) => <Report key={report.isoWeek} report={report} open={index === 0} />)}
        </div>
      )}
    </section>
  );
}
