"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { lockPlatformSettingsRow, platformAdminTransaction } from "../db";
import { parseInput, readFormFields } from "../security/parse-input";
import { requirePlatformAdmin } from "./session";

/** Switches the platform admins' daily digest email on or off (#834). An unticked box is off. Audited when it changes. */
export async function setAdminDigestAction(formData: FormData): Promise<void> {
  const session = await requirePlatformAdmin();
  const parsed = parseInput(z.strictObject({ enabled: z.literal("on").nullable() }), readFormFields(formData, ["enabled"]));
  if (!parsed.ok) return;
  const enabled = parsed.data.enabled === "on";
  await platformAdminTransaction(async (tx) => {
    await lockPlatformSettingsRow(tx);
    const before = await tx.platformSettings.findUniqueOrThrow({ where: { id: "platform" }, select: { adminDigestEnabled: true } });
    if (before.adminDigestEnabled === enabled) return;
    await tx.platformSettings.update({ where: { id: "platform" }, data: { adminDigestEnabled: enabled } });
    await tx.auditLog.create({
      data: {
        actorId: session.user.id,
        actorEmail: session.user.email,
        action: "platform.admin_digest_update",
        entityType: "platform_settings",
        entityId: "platform",
        before: { adminDigestEnabled: before.adminDigestEnabled },
        after: { adminDigestEnabled: enabled },
      },
    });
  });
  revalidatePath("/admin/settings/ai-onboarding");
}
