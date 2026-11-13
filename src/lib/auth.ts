import { betterAuth, APIError } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { twoFactor, magicLink } from "better-auth/plugins";
import { authPrisma, platform } from "./db";
import { isPrivilegedEmail, isPrivilegedUser } from "./privileged-user";
import { sendEmail } from "./email/send";
import { confirmLinkUrl, magicLinkMessage, passwordResetMessage } from "./magic-link-mail";
import { scheduleAfterResponse } from "./schedule-after-response";
import { isSlugRoutable, slugFromHost } from "./slug";

const relaxedAuth = process.env.AUTH_RATE_LIMIT_RELAXED === "1";

export function resolveAuthBaseUrl(
  env: Record<string, string | undefined> = process.env,
): string {
  if (env.BETTER_AUTH_URL) return env.BETTER_AUTH_URL;
  if (env.VERCEL_URL) return `https://${env.VERCEL_URL}`;
  return "http://localhost:3000";
}

export function resolveAuthAllowedHosts(
  env: Record<string, string | undefined> = process.env,
): string[] {
  const hosts: string[] = [];

  if (env.BETTER_AUTH_URL) {
    try {
      const host = new URL(env.BETTER_AUTH_URL).host;
      hosts.push(host, `*.${host}`);
    } catch {}
  }

  if (env.VERCEL_URL) {
    hosts.push(env.VERCEL_URL, `*.${env.VERCEL_URL}`);
  }

  if (env.BETTER_AUTH_TRUSTED_ORIGINS) {
    for (const origin of env.BETTER_AUTH_TRUSTED_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean)) {
      try {
        const host = new URL(origin).host;
        hosts.push(host, `*.${host}`);
      } catch {}
    }
  }

  if (env.PLATFORM_ROOT_DOMAIN) {
    hosts.push(env.PLATFORM_ROOT_DOMAIN, `*.${env.PLATFORM_ROOT_DOMAIN}`);
  }

  const port = env.PORT ?? "3000";
  hosts.push(`localhost:${port}`, `*.localhost:${port}`);
  if (port !== "3000") {
    hosts.push("localhost:3000", "*.localhost:3000");
  }

  hosts.push("127.0.0.1:3000", `127.0.0.1:${port}`);

  return [...new Set(hosts)];
}

export function resolveAuthTrustedOrigins(
  env: Record<string, string | undefined> = process.env,
): string[] {
  const origins: string[] = [];

  if (env.BETTER_AUTH_TRUSTED_ORIGINS) {
    origins.push(
      ...env.BETTER_AUTH_TRUSTED_ORIGINS.split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    );
  }

  if (env.VERCEL_URL) {
    origins.push(`https://${env.VERCEL_URL}`);
  }

  const port = env.PORT ?? "3000";
  origins.push(`http://localhost:${port}`, `http://*.localhost:${port}`);
  if (port !== "3000") {
    origins.push("http://localhost:3000", "http://*.localhost:3000");
  }

  return [...new Set(origins)];
}

export function validateAuthSecret(
  env: Record<string, string | undefined> = process.env,
): void {
  if (env.NEXT_PHASE === "phase-production-build") return;
  if (env.NODE_ENV !== "production") return;

  const secret = env.BETTER_AUTH_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      "BETTER_AUTH_SECRET is required in production and must be at least 32 characters. " +
        "Generate one with: openssl rand -base64 32",
    );
  }
}

export const RESEND_SANDBOX_FROM = "onboarding@resend.dev";

/**
 * Resend's sandbox sender only delivers to the account owner, so magic links never arrive.
 * Logged, not thrown: production has no EMAIL_FROM yet, and a throw would end every sign-in.
 */
export function emailFromProblem(
  env: Record<string, string | undefined> = process.env,
): string | null {
  if (env.NEXT_PHASE === "phase-production-build") return null;
  if (env.NODE_ENV !== "production") return null;
  const from = env.EMAIL_FROM?.trim();
  if (!from) return "EMAIL_FROM is not set";
  if (from.includes(RESEND_SANDBOX_FROM)) return "EMAIL_FROM is Resend's sandbox sender";
  return null;
}

validateAuthSecret();
const emailFromIssue = emailFromProblem();
if (emailFromIssue) {
  console.error(JSON.stringify({ event: "email_from_misconfigured", message: emailFromIssue }));
}

// Per-IP limits alone let someone rotating IPs flood one inbox. The row for this send already
// exists when the sender runs; links live 15 minutes, so expiry after now+5m means created in 10.
const INBOX_CAP = 5;

async function inboxCapReached(email: string): Promise<boolean> {
  const recent = await authPrisma.verification.count({
    where: {
      identifier: { startsWith: "magic-link:" },
      expiresAt: { gt: new Date(Date.now() + 5 * 60_000) },
      value: { contains: JSON.stringify(email), mode: "insensitive" },
    },
  });
  return recent > INBOX_CAP;
}

const baseUrl = resolveAuthBaseUrl();

function requestHeaders(ctx: unknown): Headers | null {
  if (!ctx || typeof ctx !== "object") return null;
  const record = ctx as { headers?: unknown; request?: { headers?: unknown } };
  if (record.headers instanceof Headers) return record.headers;
  if (record.request?.headers instanceof Headers) return record.request.headers;
  return null;
}

async function storeNameForMagicLink(ctx: unknown): Promise<string | null> {
  const headers = requestHeaders(ctx);
  if (!headers) return null;
  const headerSlug = headers.get("x-store-slug")?.toLowerCase() ?? null;
  const host = headers.get("host");
  const slug =
    headerSlug && isSlugRoutable(headerSlug)
      ? headerSlug
      : host
        ? slugFromHost(host, process.env.PLATFORM_ROOT_DOMAIN)
        : null;
  if (!slug) return null;
  try {
    const store = await platform.store.findUnique({
      where: { slug },
      select: { name: true },
    });
    return store?.name ?? null;
  } catch (error) {
    const message = error instanceof Error ? error.message : "lookup failed";
    console.error(
      JSON.stringify({ event: "magic_link_store_lookup_failed", message }),
    );
    return null;
  }
}

export const auth = betterAuth({
  baseURL: {
    allowedHosts: resolveAuthAllowedHosts(),
    protocol: "auto" as const,
    fallback: resolveAuthBaseUrl(),
  },
  database: prismaAdapter(authPrisma, { provider: "postgresql" }),
  emailAndPassword: {
    enabled: true,
    // Account recovery (ADR-0015): a reset never skips the second step, and ends every session.
    revokeSessionsOnPasswordReset: true,
    sendResetPassword: async ({ user, url }) => {
      const message = passwordResetMessage({
        to: user.email,
        url,
        fromAddress: process.env.EMAIL_FROM ?? RESEND_SANDBOX_FROM,
      });
      scheduleAfterResponse(() => sendEmail(message), "password_reset_delivery_failed");
    },
  },
  plugins: [
    twoFactor({
      issuer: "African Markets Platform",
    }),
    magicLink({
      expiresIn: 900,
      sendMagicLink: async ({ email, url }, ctx) => {
        const normalizedEmail = email.trim().toLowerCase();
        const privileged = await isPrivilegedEmail(normalizedEmail);
        if (privileged) return;
        if (await inboxCapReached(normalizedEmail)) return;
        const storeName = await storeNameForMagicLink(ctx);
        const message = magicLinkMessage({
          to: normalizedEmail,
          url: confirmLinkUrl(url),
          storeName,
          fromAddress: process.env.EMAIL_FROM ?? RESEND_SANDBOX_FROM,
        });
        scheduleAfterResponse(() => sendEmail(message), "magic_link_delivery_failed");
      },
      disableSignUp: false,
    }),
  ],
  rateLimit: {
    storage: "database",
    modelName: "rateLimit",
    window: 60,
    max: relaxedAuth ? 1000 : 10,
    customRules: {
      "/sign-in/email": { window: 60, max: relaxedAuth ? 100 : 5 },
      "/two-factor/verify-totp": { window: 60, max: relaxedAuth ? 100 : 5 },
      "/sign-in/magic-link": { window: 60, max: relaxedAuth ? 100 : 5 },
      "/request-password-reset": { window: 60, max: relaxedAuth ? 100 : 3 },
      "/two-factor/verify-backup-code": { window: 60, max: relaxedAuth ? 100 : 5 },
    },
  },
  hooks: {
    // A trusted-device cookie skips the second step but leaves twoFactorVerified false, so guards
    // would reject that session anyway: never issue one.
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path.startsWith("/two-factor/") && ctx.body?.trustDevice) {
        return { context: { body: { ...ctx.body, trustDevice: false } } };
      }
    }),
  },
  databaseHooks: {
    session: {
      create: {
        before: async (session, ctx) => {
          const path: string = (ctx as Record<string, unknown>)?.path as string ?? "";
          if (path === "/magic-link/verify") {
            const privileged = await isPrivilegedUser(session.userId);
            if (privileged) {
              throw new APIError("FORBIDDEN", { message: "This sign-in method is not available for staff accounts" });
            }
          }
          const user = await authPrisma.user.findUnique({
            where: { id: session.userId },
            select: { twoFactorEnabled: true },
          });
          if (user?.twoFactorEnabled && path.startsWith("/two-factor/")) {
            return { data: { twoFactorVerified: true } };
          }
        },
        after: async (session) => {
          if (session.twoFactorVerified) {
            await authPrisma.session.deleteMany({
              where: {
                userId: session.userId,
                id: { not: session.id },
                twoFactorVerified: false,
              },
            });
          }
        },
      },
    },
  },
  user: {
    additionalFields: {
      role: {
        type: "string",
        defaultValue: "customer",
        input: false,
      },
    },
  },
  session: {
    cookieCache: {
      enabled: false,
    },
    additionalFields: {
      twoFactorVerified: {
        type: "boolean",
        defaultValue: false,
        input: false,
      },
    },
  },
  trustedOrigins: resolveAuthTrustedOrigins(),
  advanced: {
    useSecureCookies: baseUrl.startsWith("https://"),
  },
});

export type Session = typeof auth.$Infer.Session;
