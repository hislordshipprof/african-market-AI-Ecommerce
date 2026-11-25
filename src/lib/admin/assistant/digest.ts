import { resolveAuthBaseUrl } from "../../auth";
import { platform } from "../../db";
import { emailPlatformAdmins } from "../../email/platform-admins";
import { escapeHtml } from "../../format";
import { inngest } from "../../inngest/client";
import { adminBriefing, briefingSummary, type AdminBriefing } from "./briefing";

export type AdminDigestOutcome = "off" | "nothing_waiting" | "sent";

function renderDigest(briefing: AdminBriefing, date: string, base: string): string {
  const rows = briefing.items.map((item) => {
    const names = item.names.length > 0 ? `: ${escapeHtml(item.names.join(", "))}` : "";
    return `<li><a href="${escapeHtml(`${base}${item.href}`)}">${escapeHtml(item.label)}${item.incomplete ? " or more" : ""}</a>${names}</li>`;
  });
  return [
    `<h1>Platform admin: ${date}</h1>`,
    `<p>${escapeHtml(briefingSummary(briefing.items))}</p>`,
    `<ul>${rows.join("")}</ul>`,
    briefing.unread.length > 0 ? "<p>Part of the list could not be read. Open the assistant for the rest.</p>" : "",
    `<p><a href="${escapeHtml(`${base}/admin/assistant`)}">Open the assistant</a></p>`,
    `<p>Switch this email off in AI and onboarding settings.</p>`,
  ].join("\n");
}

/**
 * The daily admin digest (#834): the assistant's briefing, emailed to every platform admin. Nothing is sent when it is
 * switched off or nothing is waiting. The day's key makes a retry send nothing new.
 */
export async function runAdminDigest(
  now: Date,
  read: (now: Date) => Promise<AdminBriefing> = adminBriefing,
  env: Record<string, string | undefined> = process.env,
): Promise<AdminDigestOutcome> {
  const settings = await platform.platformSettings.findUniqueOrThrow({ where: { id: "platform" }, select: { adminDigestEnabled: true } });
  if (!settings.adminDigestEnabled) return "off";
  const briefing = await read(now);
  if (briefing.items.length === 0) return "nothing_waiting";
  const date = now.toISOString().slice(0, 10);
  const base = resolveAuthBaseUrl(env).replace(/\/$/, "");
  await emailPlatformAdmins(`What needs an admin today, ${date}`, renderDigest(briefing, date, base), `admin-digest-${date}`);
  return "sent";
}

/** Every morning, 12:00 UTC (07:00 Eastern in winter). */
export const adminDailyDigest = inngest.createFunction(
  { id: "admin/daily-digest", triggers: [{ cron: "TZ=UTC 0 12 * * *" }] },
  async ({ step }) => step.run("send-admin-digest", () => runAdminDigest(new Date())),
);
