import { AI_ONBOARDING_LIMITS, lastAiOnboardingChange, readAiOnboardingSettings } from "@/lib/admin/ai-onboarding-settings";
import { setAdminDigestAction } from "@/lib/admin/admin-digest-actions";
import { requirePlatformAdmin } from "@/lib/admin/session";
import { platform } from "@/lib/db";
import { AiOnboardingSettingsForm } from "./ai-onboarding-settings-form";

export const metadata = { title: "AI and onboarding settings" };

const when = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" });

/** Platform-wide AI and onboarding settings (#561). Every save is audited; the latest audit row gives the "last changed" line. */
export default async function AiOnboardingSettingsPage() {
  await requirePlatformAdmin();
  const [settings, last, digest] = await Promise.all([
    readAiOnboardingSettings(),
    lastAiOnboardingChange(),
    platform.platformSettings.findUniqueOrThrow({ where: { id: "platform" }, select: { adminDigestEnabled: true } }),
  ]);

  return (
    <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-bold text-foreground">AI and onboarding settings</h1>
      <p className="mt-2 max-w-prose text-sm text-muted-foreground">
        These apply to every store. A change takes effect the next time the feature runs.
      </p>
      <p className="mt-3 text-sm text-foreground" data-testid="last-changed">
        {last ? (
          <>
            Last changed by <span className="font-medium">{last.actorEmail}</span> on{" "}
            <time dateTime={last.at.toISOString()}>{when.format(last.at)} UTC</time>.
          </>
        ) : (
          "Not changed yet. These are the defaults."
        )}
      </p>
      <AiOnboardingSettingsForm settings={settings} limits={AI_ONBOARDING_LIMITS} />
      <form action={setAdminDigestAction} className="mt-8 rounded-lg border border-border bg-card p-5">
        <h2 className="text-base font-semibold text-foreground">Admin daily email</h2>
        <label className="mt-3 flex min-h-11 items-center gap-3 text-sm text-foreground">
          <input type="checkbox" name="enabled" defaultChecked={digest.adminDigestEnabled} className="size-5 accent-primary" />
          Email every platform admin each morning what needs an admin today
        </label>
        <p className="mt-1 text-sm text-muted-foreground">No email is sent on a day with nothing waiting.</p>
        <button
          type="submit"
          className="mt-4 min-h-11 rounded-full bg-primary px-6 text-sm font-medium text-primary-foreground hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          Save email setting
        </button>
      </form>
    </div>
  );
}
