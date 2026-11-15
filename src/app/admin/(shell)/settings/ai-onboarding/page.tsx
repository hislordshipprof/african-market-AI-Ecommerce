import { AI_ONBOARDING_LIMITS, lastAiOnboardingChange, readAiOnboardingSettings } from "@/lib/admin/ai-onboarding-settings";
import { requirePlatformAdmin } from "@/lib/admin/session";
import { AiOnboardingSettingsForm } from "./ai-onboarding-settings-form";

export const metadata = { title: "AI and onboarding settings" };

const when = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" });

/** Platform-wide AI and onboarding settings (#561). Every save is audited; the latest audit row gives the "last changed" line. */
export default async function AiOnboardingSettingsPage() {
  await requirePlatformAdmin();
  const [settings, last] = await Promise.all([readAiOnboardingSettings(), lastAiOnboardingChange()]);

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
    </div>
  );
}
