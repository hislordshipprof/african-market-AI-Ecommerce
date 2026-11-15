import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { testPrismaClient } from "@/lib/test-prisma";
import { storeScoped, storeScopedTransaction } from "../db";
import { ResendSender, setEmailSenderForTests, type EmailMessage } from "../email/send";
import { liveSandbox, providerSandbox } from "../test-live-provider";
import { retryFailedReports } from "./weekly-report";

const apiKey = process.env.RESEND_API_KEY;
const fromAddress = process.env.EMAIL_FROM ?? "onboarding@resend.dev";
const hasDb = !!process.env.DATABASE_URL;
const RUN = `s618-${Date.now().toString(36)}`;
/** Monday 16 Nov 2026, 08:00 UTC: the store below is due, and the report covers ISO week 2026-W46. */
const MONDAY_8AM = "2026-11-16T08:00:00.000Z";

// Sends real email, so it runs only with LIVE_SANDBOX=1 and the daily quota can still run out (#591).
const sandbox = providerSandbox("Resend");

describe.skipIf(!liveSandbox || !apiKey || !hasDb)("Resend weekly report sandbox (#550)", () => {
  let raw: PrismaClient;
  let storeId = "";
  const ownerId = `weekly-sandbox-${RUN}`;
  const ownerEmail = `delivered+${RUN}@resend.dev`;

  beforeAll(async () => {
    raw = testPrismaClient();
    storeId = (await raw.store.create({ data: { slug: `weekly-sandbox-${RUN}`, name: "Sandbox African Market", timezone: "UTC", digestHour: 8 } })).id;
    await raw.user.create({ data: { id: ownerId, name: "Sandbox owner", email: ownerEmail } });
    await storeScoped(storeId).storeMembership.create({ data: { storeId, userId: ownerId, role: "owner" } });
  });

  afterEach(() => setEmailSenderForTests(null));

  afterAll(async () => {
    if (storeId) {
      await storeScopedTransaction(storeId, (tx) => tx.copilotWeeklyReport.deleteMany({}));
      await storeScoped(storeId).storeMembership.deleteMany({});
      await raw.store.delete({ where: { id: storeId } }).catch(() => undefined);
    }
    await raw.user.delete({ where: { id: ownerId } }).catch(() => undefined);
    await raw.$disconnect();
  });

  it("delivers the owner's report through Resend, and its key replays the same email id", sandbox.test(async () => {
    const resend = new ResendSender(apiKey!, fromAddress);
    const sent: Array<{ message: EmailMessage; id: string }> = [];
    setEmailSenderForTests({
      async send(message) {
        const result = await resend.send(message);
        sent.push({ message, id: result.id });
        return result;
      },
    });

    // Given only this store's id, so no other due store in the lane database is emailed for real.
    await retryFailedReports([storeId], MONDAY_8AM);

    expect(sent).toHaveLength(1);
    const [{ message, id }] = sent as [{ message: EmailMessage; id: string }];
    expect(message.to).toBe(ownerEmail);
    expect(message.subject).toBe("Sandbox African Market: your week, Nov 9 to Nov 15");
    expect(message.idempotencyKey).toMatch(new RegExp(`^copilot-weekly:${storeId}:2026-W46:${ownerId}:[0-9a-f]{16}$`));
    expect(id).toMatch(/\S/);
    const [row] = await storeScopedTransaction(storeId, (tx) => tx.copilotWeeklyReport.findMany());
    expect(row).toMatchObject({ isoWeek: "2026-W46", deliveredTo: [ownerId] });
    expect(row!.sentAt).not.toBeNull();

    // A retry that lost the first response sends the same body with the same key: Resend accepts it once.
    expect((await resend.send(message)).id).toBe(id);
  }), 30_000);
});
