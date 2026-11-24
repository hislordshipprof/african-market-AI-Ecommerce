import { betterAuth, APIError } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { twoFactor, magicLink } from "better-auth/plugins";
import { authPrisma, countMagicLinksForEmail, platform } from "./db";
import { isPrivilegedEmail, isPrivilegedUser, isStaffUser } from "./privileged-user";
import { sendEmail } from "./email/send";
import { confirmLinkUrl, magicLinkMessage, passwordResetMessage } from "./magic-link-mail";
import { scheduleAfterResponse } from "./schedule-after-response";
import { fallbackRootHost, isFallbackRoot, isSlugRoutable, slugFromHost } from "./slug";
import { testOnlyRoutesAllowed } from "./security/test-only-routes";

/**
 * A real deployment: VERCEL set, or NODE_ENV=production without CI=true (the /api/e2e rule).
 * The CI and e2e server is `next start` with CI=true, so it keeps its test settings.
 */
function isDeployment(env: Record<string, string | undefined>): boolean {
  return !testOnlyRoutesAllowed(env, "1");
}

export function resolveAuthRateLimitRelaxed(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return testOnlyRoutesAllowed(env, env.AUTH_RATE_LIMIT_RELAXED);
}

const relaxedAuth = resolveAuthRateLimitRelaxed();

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

  // Exactly the alias: it has no store subdomains (#766).
  const alias = fallbackRootHost(env);
  if (alias) hosts.push(alias);

  if (!isDeployment(env)) {
    const port = env.PORT ?? "3000";
    hosts.push(`localhost:${port}`, `*.localhost:${port}`);
    if (port !== "3000") {
      hosts.push("localhost:3000", "*.localhost:3000");
    }
    hosts.push("127.0.0.1:3000", `127.0.0.1:${port}`);
  }

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

  const alias = fallbackRootHost(env);
  if (alias) origins.push(`https://${alias}`);

  if (!isDeployment(env)) {
    const port = env.PORT ?? "3000";
    origins.push(`http://localhost:${port}`, `http://*.localhost:${port}`);
    if (port !== "3000") {
      origins.push("http://localhost:3000", "http://*.localhost:3000");
    }
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
  // The committed CI secret (.env.e2e, ci.yml) is marked do-not-use; the CI server itself still runs on it.
  if (isDeployment(env) && secret.includes("do-not-use")) {
    throw new Error("BETTER_AUTH_SECRET is a committed test secret. Generate one with: openssl rand -base64 32");
  }
}

export function resolveAuthSecureCookies(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return isDeployment(env) || resolveAuthBaseUrl(env).startsWith("https://");
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
// A blocked send deletes its row, so only mailed links count and a trickle cannot hold the cap.
const INBOX_CAP = 5;

async function inboxCapReached(email: string): Promise<boolean> {
  return (await countMagicLinksForEmail(email, new Date(Date.now() + 5 * 60_000))) > INBOX_CAP;
}

const baseUrl = resolveAuthBaseUrl();

const promotedOnVerify = new WeakSet<object>();

function requestHeaders(ctx: unknown): Headers | null {
  if (!ctx || typeof ctx !== "object") return null;
  const record = ctx as { headers?: unknown; request?: { headers?: unknown } };
  if (record.headers instanceof Headers) return record.headers;
  if (record.request?.headers instanceof Headers) return record.request.headers;
  return null;
}

// The proxy sets x-custom-domain from the Host; only a domain a store has registered counts.
export async function registeredCustomDomain(headers: Headers): Promise<string | null> {
  const customDomain = headers.get("x-custom-domain");
  if (!customDomain) return null;
  const store = await platform.store.findUnique({
    where: { customDomain },
    select: { customDomain: true },
  });
  return store?.customDomain ?? null;
}

// A custom domain is served on the deployment's scheme: https live, http on a local server.
function customDomainOrigin(domain: string): string {
  return `${new URL(baseUrl).protocol}//${domain}`;
}

async function trustedOriginsForRequest(request?: Request): Promise<string[]> {
  const origins = resolveAuthTrustedOrigins();
  const domain = request ? await registeredCustomDomain(request.headers) : null;
  return domain ? [...origins, customDomainOrigin(domain)] : origins;
}

function onOrigin(url: string, origin: string): string {
  const target = new URL(url, baseUrl);
  if (target.origin !== new URL(baseUrl).origin) return url;
  return new URL(`${target.pathname}${target.search}${target.hash}`, origin).toString();
}

// Better Auth builds links and redirects on its fallback base URL for hosts outside
// allowedHosts, which is static; move those onto the store's custom domain.
export function onCustomDomain(url: string, domain: string): string {
  return onOrigin(url, customDomainOrigin(domain));
}

type RequestStore = {
  id: string;
  name: string;
  slug: string;
  customDomain: string | null;
  customDomainVerifiedAt: Date | null;
};

// The store a request is on: its subdomain slug, or a domain a store has registered.
async function storeForRequest(headers: Headers): Promise<RequestStore | null> {
  const headerSlug = headers.get("x-store-slug")?.toLowerCase() ?? null;
  const customDomain = headers.get("x-custom-domain");
  const host = headers.get("host");
  const slug =
    headerSlug && isSlugRoutable(headerSlug)
      ? headerSlug
      : !customDomain && host
        ? slugFromHost(host, process.env.PLATFORM_ROOT_DOMAIN)
        : null;
  if (!slug && !customDomain) return null;
  return platform.store.findUnique({
    where: slug ? { slug } : { customDomain: customDomain! },
    select: { id: true, name: true, slug: true, customDomain: true, customDomainVerifiedAt: true },
  });
}

async function storeForMagicLink(ctx: unknown): Promise<RequestStore | null> {
  const headers = requestHeaders(ctx);
  if (!headers) return null;
  try {
    return await storeForRequest(headers);
  } catch (error) {
    const message = error instanceof Error ? error.message : "lookup failed";
    console.error(
      JSON.stringify({ event: "magic_link_store_lookup_failed", message }),
    );
    return null;
  }
}

// A link asked for on a custom domain goes there only once Vercel has verified it for this
// store (#711); otherwise to the store's platform subdomain, which the platform controls.
function magicLinkUrlForStore(url: string, ctx: unknown, store: RequestStore | null): string {
  if (!store?.customDomain || !requestHeaders(ctx)?.get("x-custom-domain")) return url;
  if (store.customDomainVerifiedAt) return onCustomDomain(url, store.customDomain);
  const root = process.env.PLATFORM_ROOT_DOMAIN;
  if (!root) return url;
  const base = new URL(baseUrl);
  return onOrigin(url, `${base.protocol}//${store.slug}.${root}${base.port ? `:${base.port}` : ""}`);
}

// The production alias has no store subdomains: the link names its store, which the proxy remembers
// on arrival, so it opens in a browser that never visited the store (#766).
function nameStoreOnAlias(url: string, ctx: unknown, store: RequestStore | null): string {
  const host = requestHeaders(ctx)?.get("host");
  if (!store || !host || !isFallbackRoot(host, process.env)) return url;
  const link = new URL(url);
  link.searchParams.set("store", store.slug);
  return link.toString();
}

const MAGIC_LINK_TTL_SECONDS = 900;
const magicLinkStoreIdentifier = (token: string) => `magic-link-store:${token}`;

// A token is redeemable only on the store it was asked for on (#711); a live token with no store
// record is refused too. An unknown or expired token falls through to Better Auth's INVALID_TOKEN.
async function refuseTokenFromAnotherStore(ctx: {
  query?: Record<string, unknown>;
  context: { internalAdapter: { findVerificationValue(identifier: string): Promise<{ value: string } | null> } };
}): Promise<void> {
  const token = ctx.query?.token;
  if (typeof token !== "string") return;
  const adapter = ctx.context.internalAdapter;
  const binding = await adapter.findVerificationValue(magicLinkStoreIdentifier(token));
  if (!binding) {
    if (await adapter.findVerificationValue(`magic-link:${token}`)) throw refusedHere();
    return;
  }
  const headers = requestHeaders(ctx);
  const store = headers ? await storeForRequest(headers) : null;
  if (binding.value !== (store?.id ?? "")) throw refusedHere();
}

function refusedHere(): APIError {
  return new APIError("FORBIDDEN", { message: "This sign-in link is not valid here" });
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
    // Accounts come from magic links (shoppers) or staff invites (/api/invite/password), never open sign-up.
    disableSignUp: true,
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
      expiresIn: MAGIC_LINK_TTL_SECONDS,
      sendMagicLink: async ({ email, url, token }, ctx) => {
        const normalizedEmail = email.trim().toLowerCase();
        const privileged = await isPrivilegedEmail(normalizedEmail);
        if (privileged) return;
        if (await inboxCapReached(normalizedEmail)) {
          await authPrisma.verification.deleteMany({ where: { identifier: `magic-link:${token}` } });
          return;
        }
        const store = await storeForMagicLink(ctx);
        await authPrisma.verification.create({
          data: {
            id: crypto.randomUUID(),
            identifier: magicLinkStoreIdentifier(token),
            value: store?.id ?? "",
            expiresAt: new Date(Date.now() + MAGIC_LINK_TTL_SECONDS * 1000),
          },
        });
        const message = magicLinkMessage({
          to: normalizedEmail,
          url: nameStoreOnAlias(confirmLinkUrl(magicLinkUrlForStore(url, ctx, store)), ctx, store),
          storeName: store?.name ?? null,
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
    // A window restarts only after a quiet minute, so relaxed (e2e) limits must cover a whole run from one IP.
    customRules: {
      "/sign-in/email": { window: 60, max: relaxedAuth ? 1000 : 5 },
      "/two-factor/verify-totp": { window: 60, max: relaxedAuth ? 1000 : 5 },
      "/sign-in/magic-link": { window: 60, max: relaxedAuth ? 1000 : 5 },
      // The magic-link plugin's own rule (5 a minute) covers verify too; 5 is that default.
      "/magic-link/verify": { window: 60, max: relaxedAuth ? 1000 : 5 },
      "/request-password-reset": { window: 60, max: relaxedAuth ? 1000 : 3 },
      "/two-factor/verify-backup-code": { window: 60, max: relaxedAuth ? 1000 : 5 },
    },
  },
  hooks: {
    // A trusted-device cookie skips the second step but leaves twoFactorVerified false, so guards
    // would reject that session anyway: never issue one.
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path === "/magic-link/verify") await refuseTokenFromAnotherStore(ctx);
      if (ctx.path.startsWith("/two-factor/") && ctx.body?.trustDevice) {
        return { context: { body: { ...ctx.body, trustDevice: false } } };
      }
      // The storefront never sends a name. Blanked, not dropped: hook context merges skip undefined.
      if (ctx.path === "/sign-in/magic-link" && ctx.body?.name) {
        return { context: { body: { ...ctx.body, name: "" } } };
      }
      // Accounts carry no picture, and a name is at most 80 characters. Edited in place: a returned
      // body is merged over the original, which would bring a dropped image back.
      if (ctx.path === "/update-user" && ctx.body && typeof ctx.body === "object") {
        const body = ctx.body as Record<string, unknown>;
        delete body.image;
        if (typeof body.name === "string") body.name = body.name.slice(0, 80);
      }
    }),
  },
  databaseHooks: {
    user: {
      update: {
        // On /magic-link/verify, Better Auth sets emailVerified only when it promotes an unproven
        // account (revokeUnprovenAccountAccess), so any 2FA on it was enrolled before the mailbox was
        // proven: a squatter's. Mark the request here; the after hook has the user id.
        before: async (data, ctx) => {
          const path = (ctx as Record<string, unknown> | null)?.path;
          if (path === "/magic-link/verify" && data.emailVerified === true && ctx) promotedOnVerify.add(ctx);
        },
        // Clear the squatter's factor so the mailbox owner can sign in. Staff keep theirs (pre-#710
        // invitees were never verified); their magic-link session is refused anyway.
        after: async (user, ctx) => {
          if (!ctx || !promotedOnVerify.has(ctx) || !user.twoFactorEnabled) return;
          if (await isStaffUser(user.id)) return;
          await authPrisma.twoFactor.deleteMany({ where: { userId: user.id } });
          await authPrisma.user.update({ where: { id: user.id }, data: { twoFactorEnabled: false } });
        },
      },
    },
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
  trustedOrigins: trustedOriginsForRequest,
  advanced: {
    useSecureCookies: resolveAuthSecureCookies(),
    // Vercel sets the first two; a multi-hop x-forwarded-for alone resolves to no IP (one shared bucket).
    ipAddress: { ipAddressHeaders: ["x-vercel-forwarded-for", "x-real-ip", "x-forwarded-for"] },
  },
});

export type Session = typeof auth.$Infer.Session;
