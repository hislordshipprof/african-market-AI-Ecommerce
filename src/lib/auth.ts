import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { twoFactor } from "better-auth/plugins";
import { authPrisma } from "./db";

export const auth = betterAuth({
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
      "/sign-in/email": { window: 60, max: 5 },
      "/two-factor/verify-totp": { window: 60, max: 5 },
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
      enabled: true,
      maxAge: 300,
    },
  },
  trustedOrigins: process.env.BETTER_AUTH_TRUSTED_ORIGINS
    ? process.env.BETTER_AUTH_TRUSTED_ORIGINS.split(",")
    : [],
});

export type Session = typeof auth.$Infer.Session;
