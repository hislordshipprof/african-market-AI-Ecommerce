import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { twoFactor } from "better-auth/plugins";
import { authPrisma } from "./db";

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

  origins.push("http://localhost:3000", "http://*.localhost:3000");

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
  ],
  rateLimit: {
    storage: "database",
    modelName: "rateLimit",
    window: 60,
    max: 10,
    customRules: {
      "/sign-in/email": { window: 60, max: relaxedAuth ? 100 : 5 },
      "/two-factor/verify-totp": { window: 60, max: relaxedAuth ? 100 : 5 },
    },
  },
  databaseHooks: {
    session: {
      create: {
        before: async (session) => {
          const user = await authPrisma.user.findUnique({
            where: { id: session.userId },
            select: { twoFactorEnabled: true },
          });
          if (user?.twoFactorEnabled) {
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
