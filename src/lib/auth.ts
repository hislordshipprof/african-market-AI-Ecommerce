import { betterAuth, APIError } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { twoFactor, magicLink } from "better-auth/plugins";
import { authPrisma, platformAdmin } from "./db";
import { sendEmail } from "./email/send";

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

validateAuthSecret();

const baseUrl = resolveAuthBaseUrl();

async function isPrivilegedUser(userId: string): Promise<boolean> {
  const user = await authPrisma.user.findUnique({
    where: { id: userId },
    select: { role: true, twoFactorEnabled: true },
  });
  if (!user) return false;
  if (user.role !== "customer" || user.twoFactorEnabled) return true;
  const memberships = await platformAdmin.storeMembership.findMany({
    where: { userId },
    select: { id: true },
    take: 1,
  });
  return memberships.length > 0;
}

async function isPrivilegedEmail(email: string): Promise<boolean> {
  const user = await authPrisma.user.findFirst({
    where: { email },
    select: { id: true, role: true, twoFactorEnabled: true },
  });
  if (!user) return false;
  if (user.role !== "customer" || user.twoFactorEnabled) return true;
  const memberships = await platformAdmin.storeMembership.findMany({
    where: { userId: user.id },
    select: { id: true },
    take: 1,
  });
  return memberships.length > 0;
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
  },
  plugins: [
    twoFactor({
      issuer: "African Markets Platform",
    }),
    magicLink({
      expiresIn: 900,
      sendMagicLink: async ({ email, url }) => {
        const normalizedEmail = email.trim().toLowerCase();
        const privileged = await isPrivilegedEmail(normalizedEmail);
        if (privileged) return;
        sendEmail({
          to: normalizedEmail,
          subject: "Sign in to African Markets",
          html: `<p>Click <a href="${url}">here</a> to sign in. This link expires in 15 minutes.</p>`,
        }).catch(() => {});
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
    },
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
