import { Prisma } from "@prisma/client";
import { z } from "zod";
import { platformAdmin, platformAdminTransaction } from "../db";
import { takeRateLimit } from "../rate-limit/app-limiter";
import { normalizeEmail } from "../email";
import { sendEmail, type EmailMessage } from "../email/send";
import { escapeHtml } from "../format";
import { USPS_STATE_CODES } from "../customer-account/address-validation";
import { isSlugRoutable } from "../slug";
import { coordinatesForStore, insertStore, type NewStoreValues } from "../admin/store-create";
import { recordInvite, sendInviteEmail, type CreateInviteInput } from "../invite/service";
import { resolveAuthBaseUrl } from "../auth";
import { requestCourierRegistration } from "../delivery/courier-registration";
import { revalidateStore } from "../get-store";
import { readAiOnboardingSettings } from "../admin/ai-onboarding-settings";
import { REJECT_REASON_MAX, STORE_TYPES } from "./fields";

const HOUR_MS = 60 * 60 * 1000;
const PER_IP_PER_HOUR = 5;

type Actor = { id: string; email: string };

export type SubmitResult =
  | { ok: true }
  | { ok: false; fieldErrors: Record<string, string> }
  | { ok: false; rateLimited: true; retryAfter: number };

function text(max: number, message: string) {
  return z.string().trim().min(1, message).max(max, message);
}

/** 10 digits, or 11 starting with 1, as E.164. Couriers and SMS take E.164 (#527). */
function usPhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

/** A web or social link; a bare host gets https://. Only http and https are kept, so the admin page never links a script. */
function webLink(raw: string): string | null {
  const withScheme = raw.includes("://") ? raw : `https://${raw}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (!url.hostname.includes(".")) return null;
    return url.toString();
  } catch {
    return null;
  }
}

const applicationSchema = z.object({
  businessName: text(120, "Enter the store's name"),
  storeType: z.enum(STORE_TYPES.map((type) => type.value) as [string, ...string[]], { message: "Pick the kind of store" }),
  addressLine1: text(100, "Enter the street address"),
  city: text(60, "Enter the city"),
  state: z.string().trim().toUpperCase().refine((state) => (USPS_STATE_CODES as readonly string[]).includes(state), "Pick a US state"),
  zip: z.string().trim().regex(/^\d{5}$/, "Enter a 5-digit ZIP code"),
  ownerName: text(120, "Enter your name"),
  email: z.string().trim().max(254).transform(normalizeEmail).pipe(z.email("Enter a valid email address")),
  phone: z.string().trim().max(40).transform((raw, ctx) => {
    const phone = usPhone(raw);
    if (!phone) {
      ctx.addIssue({ code: "custom", message: "Enter a 10-digit US phone number" });
      return z.NEVER;
    }
    return phone;
  }),
  website: z.string().trim().max(300).transform((raw, ctx) => {
    if (!raw) return null;
    const link = webLink(raw);
    if (!link) {
      ctx.addIssue({ code: "custom", message: "Enter a web address, like instagram.com/yourstore" });
      return z.NEVER;
    }
    return link;
  }),
  offersPickup: z.boolean(),
  offersDelivery: z.boolean(),
});

function formValue(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  return typeof value === "string" ? value : "";
}

/**
 * The public /sell form (#554). A filled honeypot gets the normal thank-you and nothing is stored. Valid applications
 * count against 5 an hour per IP, so a typo does not use one up. A second pending application from the same email or
 * phone is dropped silently, which also keeps the form from telling anyone who has applied.
 */
export async function submitStoreApplication(
  input: Record<string, unknown>,
  ip: string,
  now = Date.now(),
): Promise<SubmitResult> {
  if (formValue(input, "fax").trim() !== "") return { ok: true };

  const parsed = applicationSchema.safeParse({
    businessName: formValue(input, "businessName"),
    storeType: formValue(input, "storeType"),
    addressLine1: formValue(input, "addressLine1"),
    city: formValue(input, "city"),
    state: formValue(input, "state"),
    zip: formValue(input, "zip"),
    ownerName: formValue(input, "ownerName"),
    email: formValue(input, "email"),
    phone: formValue(input, "phone"),
    website: formValue(input, "website"),
    offersPickup: formValue(input, "offersPickup") === "on",
    offersDelivery: formValue(input, "offersDelivery") === "on",
  });
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? "form");
      fieldErrors[key] ??= issue.message;
    }
    return { ok: false, fieldErrors };
  }

  const limit = await takeRateLimit(`store-application:ip:${ip}`, PER_IP_PER_HOUR, HOUR_MS, now);
  if (!limit.ok) return { ok: false, rateLimited: true, retryAfter: limit.retryAfter };

  try {
    await platformAdmin.storeApplication.create({ data: parsed.data });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return { ok: true };
    throw err;
  }
  return { ok: true };
}

export async function listStoreApplications() {
  const [pending, decided] = await Promise.all([
    platformAdmin.storeApplication.findMany({
      where: { status: "pending" },
      orderBy: { createdAt: "asc" },
      take: 200,
    }),
    platformAdmin.storeApplication.findMany({
      where: { status: { not: "pending" } },
      orderBy: { decidedAt: "desc" },
      take: 50,
      include: { store: { select: { id: true, slug: true } } },
    }),
  ]);
  return { pending, decided };
}

export type ApproveResult =
  | { ok: true; storeId: string; inviteEmailed: boolean }
  | { ok: false; error: string; field?: "slug" };

class AlreadyDecided extends Error {}

const DECIDED = "This application was already decided. Reload the page.";
const SLUG_TAKEN = "A store with this slug already exists";

/**
 * Approve (#554): in one transaction the application is claimed, the store is created in `setup` with the shared
 * insert and its `store.create` audit row, the owner invite is recorded, and one `store_application.approve` audit row
 * is written. The claim is a conditional update, so a second approve of the same application changes nothing.
 * After commit: the invite email, and the courier registration job (its daily retry covers a failed queue).
 */
export async function approveStoreApplication(id: string, rawSlug: string, actor: Actor): Promise<ApproveResult> {
  const slug = rawSlug.trim().toLowerCase();
  if (!isSlugRoutable(slug)) {
    return { ok: false, field: "slug", error: "Use lowercase letters, numbers and hyphens; some words are reserved" };
  }
  const application = await platformAdmin.storeApplication.findUnique({ where: { id } });
  if (!application || application.status !== "pending") return { ok: false, error: DECIDED };
  if (await platformAdmin.store.findUnique({ where: { slug }, select: { id: true } })) {
    return { ok: false, field: "slug", error: SLUG_TAKEN };
  }

  const address = {
    addressLine1: application.addressLine1,
    addressLine2: null,
    city: application.city,
    state: application.state,
    zip: application.zip,
  };
  const coords = await coordinatesForStore({ ...address, storeDeliveryEnabled: false }, null);
  const values: NewStoreValues = {
    slug,
    name: application.businessName,
    logoUrl: null,
    brandColor: null,
    themePreset: "palm-and-shea",
    hours: null,
    prepTimeMinutes: 30,
    deliveryRadiusMi: 8,
    minimumOrderCents: 3500,
    pickupEnabled: false,
    autoRefundLimitCents: 2500,
    supportSlaMinutes: 30,
    timezone: "America/New_York",
    ...address,
    phone: application.phone,
    lat: "error" in coords ? null : coords.lat,
    lng: "error" in coords ? null : coords.lng,
    storeDeliveryEnabled: false,
    storeDeliveryFeeCents: 0,
    pickupSlotSettings: null,
    storeDeliverySlotSettings: null,
  };

  let created;
  try {
    created = await platformAdminTransaction(async (tx) => {
      const claimed = await tx.storeApplication.updateMany({
        where: { id, status: "pending" },
        data: { status: "approved", decidedAt: new Date(), decidedByEmail: actor.email },
      });
      if (claimed.count === 0) throw new AlreadyDecided();
      const store = await insertStore(tx, values, actor);
      await tx.storeApplication.update({ where: { id }, data: { storeId: store.id } });
      const inviteInput: CreateInviteInput = {
        storeId: store.id,
        email: application.email,
        role: "owner",
        invitedById: actor.id,
        actorEmail: actor.email,
        baseUrl: resolveAuthBaseUrl(),
        storeSlug: store.slug,
        storeName: store.name,
      };
      const invite = await recordInvite(tx, inviteInput);
      await tx.auditLog.create({
        data: {
          storeId: store.id,
          actorId: actor.id,
          actorEmail: actor.email,
          action: "store_application.approve",
          entityType: "store_application",
          entityId: id,
          after: { storeId: store.id, slug: store.slug, inviteId: invite.id },
        },
      });
      return { store, invite, inviteInput };
    });
  } catch (err) {
    if (err instanceof AlreadyDecided) return { ok: false, error: DECIDED };
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return { ok: false, field: "slug", error: SLUG_TAKEN };
    }
    throw err;
  }

  revalidateStore(created.store);
  let inviteEmailed = true;
  try {
    await sendInviteEmail(created.inviteInput, created.invite);
  } catch (err) {
    inviteEmailed = false;
    console.error(JSON.stringify({
      event: "store_application_invite_email_failed",
      applicationId: id,
      storeId: created.store.id,
      message: err instanceof Error ? err.message : "send failed",
    }));
  }
  await requestCourierRegistration(created.store.id);
  return { ok: true, storeId: created.store.id, inviteEmailed };
}

export type RejectResult = { ok: true; emailed: boolean } | { ok: false; error: string };

/**
 * Reject (#554) saves the internal reason and sends one plain email that never contains it. If the email fails the
 * rejection stands; calling this again on that application sends the email, once.
 */
export async function rejectStoreApplication(id: string, rawReason: string, actor: Actor): Promise<RejectResult> {
  const reason = rawReason.trim();
  const application = await platformAdmin.storeApplication.findUnique({ where: { id } });
  if (!application) return { ok: false, error: DECIDED };

  const resend = application.status === "rejected" && application.rejectionEmailedAt === null;
  if (!resend) {
    if (application.status !== "pending") return { ok: false, error: DECIDED };
    if (!reason) return { ok: false, error: "Write the reason. The applicant never sees it." };
    if (reason.length > REJECT_REASON_MAX) return { ok: false, error: `Keep the reason under ${REJECT_REASON_MAX} characters` };
    try {
      await platformAdminTransaction(async (tx) => {
        const claimed = await tx.storeApplication.updateMany({
          where: { id, status: "pending" },
          data: { status: "rejected", rejectReason: reason, decidedAt: new Date(), decidedByEmail: actor.email },
        });
        if (claimed.count === 0) throw new AlreadyDecided();
        await tx.auditLog.create({
          data: {
            actorId: actor.id,
            actorEmail: actor.email,
            action: "store_application.reject",
            entityType: "store_application",
            entityId: id,
            after: { reason },
          },
        });
      });
    } catch (err) {
      if (err instanceof AlreadyDecided) return { ok: false, error: DECIDED };
      throw err;
    }
  }

  try {
    await sendEmail(rejectionMessage(application));
  } catch (err) {
    console.error(JSON.stringify({
      event: "store_application_reject_email_failed",
      applicationId: id,
      message: err instanceof Error ? err.message : "send failed",
    }));
    return { ok: true, emailed: false };
  }
  await platformAdmin.storeApplication.updateMany({
    where: { id, rejectionEmailedAt: null },
    data: { rejectionEmailedAt: new Date() },
  });
  return { ok: true, emailed: true };
}

/** The one plain rejection email. It names no reason; the idempotency key stops a retry from mailing twice. */
export function rejectionMessage(application: { id: string; email: string; ownerName: string; businessName: string }): EmailMessage {
  return {
    to: application.email,
    subject: "Your application to sell on African Markets",
    html: rejectionHtml(application.ownerName, application.businessName),
    idempotencyKey: `store-application-rejected/${application.id}`,
  };
}

function rejectionHtml(ownerName: string, businessName: string): string {
  return `
    <div style="font-family: system-ui, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 16px; color: #1a1a18;">
      <p style="font-size: 16px; line-height: 1.5;">Hello ${escapeHtml(ownerName)},</p>
      <p style="font-size: 16px; line-height: 1.5;">
        Thank you for applying to sell ${escapeHtml(businessName)} on African Markets.
        We can't offer you a store at this time.
      </p>
      <p style="font-size: 16px; line-height: 1.5;">You're welcome to apply again later.</p>
      <p style="font-size: 16px; line-height: 1.5;">The African Markets team</p>
    </div>
  `;
}

/** Rejected applications are kept for the retention set in AI and onboarding settings (#561), then deleted by the daily job. */
export async function deleteExpiredRejectedApplications(now = new Date()): Promise<number> {
  const { rejectedApplicationRetentionMonths } = await readAiOnboardingSettings();
  const cutoff = new Date(now);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - rejectedApplicationRetentionMonths);
  const { count } = await platformAdmin.storeApplication.deleteMany({
    where: { status: "rejected", decidedAt: { lt: cutoff } },
  });
  return count;
}
