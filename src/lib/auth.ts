import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { twoFactor, magicLink, phoneNumber } from "better-auth/plugins";
import { authPrisma } from "./db";
import { sendEmail } from "./email/send";
import { getSmsSender } from "./sms";
import { normalizePhone } from "./phone";
import { checkPhoneRateLimit, recordPhoneOtpSend } from "./phone-rate-limit";

const relaxedAuth = process.env.AUTH_RATE_LIMIT_RELAXED === "1";

export function resolveAuthBaseUrl(
  env: Record<string, string | undefined> = process.env,
): string {
  if (env.BETTER_AUTH_URL) return env.BETTER_AUTH_URL;
  if (env.VERCEL_URL) return `https://${env.VERCEL_URL}`;
  return "http://localhost:3000";
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

validateAuthSecret();

const baseUrl = resolveAuthBaseUrl();

export const auth = betterAuth({
  baseURL: baseUrl,
  database: prismaAdapter(authPrisma, { provider: "postgresql" }),
  emailAndPassword: {
    enabled: true,
  },
  plugins: [
    twoFactor({
      issuer: "African Markets Platform",
    }),
    magicLink({
      sendMagicLink: async ({ email, url }) => {
        await sendEmail({
          to: email,
          subject: "Sign in to African Markets",
          html: `<p>Click <a href="${url}">here</a> to sign in. This link expires in 5 minutes.</p>`,
        });
      },
      disableSignUp: false,
    }),
    ...(getSmsSender()
      ? [
          phoneNumber({
            sendOTP: async ({ phoneNumber: phone, code }) => {
              const normalized = normalizePhone(phone);
              if (!normalized) throw new Error("Invalid phone number");
              await checkPhoneRateLimit(normalized);
              const sender = getSmsSender();
              if (!sender) throw new Error("SMS not configured");
              await sender.send({
                to: normalized,
                body: `Your African Markets verification code is ${code}. It expires in 5 minutes.`,
              });
              await recordPhoneOtpSend(normalized);
            },
            phoneNumberValidator: (phone) => normalizePhone(phone) !== null,
            signUpOnVerification: {
              getTempEmail: (phone) => `${phone.replace(/\D/g, "")}@phone.placeholder.local`,
            },
          }),
        ]
      : []),
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
      "/phone-number/send-otp": { window: 60, max: relaxedAuth ? 100 : 3 },
      "/sign-in/phone-number": { window: 60, max: relaxedAuth ? 100 : 5 },
    },
  },
  databaseHooks: {
    session: {
      create: {
        before: async (session, ctx) => {
          const user = await authPrisma.user.findUnique({
            where: { id: session.userId },
            select: { twoFactorEnabled: true },
          });
          if (user?.twoFactorEnabled) {
            const path: string = (ctx as Record<string, unknown>)?.path as string ?? "";
            if (path.startsWith("/two-factor/")) {
              return { data: { twoFactorVerified: true } };
            }
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

export const smsEnabled = getSmsSender() !== null;
