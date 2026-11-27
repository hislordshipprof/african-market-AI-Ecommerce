import { clientIp } from "../assistant/client-ip";
import { logSecurityEvent } from "./events";

/** The plain error every covered form shows for a missing or failed check (#872). */
export const TURNSTILE_FAILED = "Please confirm you're not a robot and try again.";
/** The hidden input the widget adds inside a form. */
export const TURNSTILE_FIELD = "cf-turnstile-response";
/** Carries the token on a request to the auth route's magic-link sign-in. */
export const TURNSTILE_HEADER = "x-turnstile-token";

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const TIMEOUT_MS = 5000;
// Cloudflare's published test secrets; their answers always name example.com as the hostname.
const TEST_SECRET = /^[123]x0+AA$/;

type Env = Record<string, string | undefined>;
export type TurnstileCheck = { ok: true } | { ok: false; reason: "missing" | "rejected" | "unavailable" };

function keys(env: Env): { site: string; secret: string } | null {
  const site = env.NEXT_PUBLIC_TURNSTILE_SITE_KEY?.trim();
  const secret = env.TURNSTILE_SECRET_KEY?.trim();
  return site && secret ? { site, secret } : null;
}

/** The site key for the widget, read at request time; null (no widget, no check) until both keys are set. */
export function turnstileSiteKey(env: Env = process.env): string | null {
  return keys(env)?.site ?? null;
}

/**
 * Checks a widget token with Cloudflare: only success on the request's own host passes.
 * The caller decides what "unavailable" (siteverify unreachable) means for its form.
 */
export async function verifyTurnstile(
  token: unknown,
  request: { ip: string; host: string | null },
  deps: { env?: Env; fetch?: typeof fetch } = {},
): Promise<TurnstileCheck> {
  const configured = keys(deps.env ?? process.env);
  if (!configured) return { ok: true };
  if (typeof token !== "string" || !token || token.length > 2048) return { ok: false, reason: "missing" };

  const body = new URLSearchParams({ secret: configured.secret, response: token });
  if (request.ip !== "unknown") body.set("remoteip", request.ip);
  let answer: { success?: unknown; hostname?: unknown; "error-codes"?: unknown };
  try {
    const res = await (deps.fetch ?? fetch)(SITEVERIFY, { method: "POST", body, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`siteverify ${res.status}`);
    answer = await res.json();
  } catch (err) {
    logSecurityEvent("turnstile_unavailable", { message: err instanceof Error ? err.message.slice(0, 120) : "failed" });
    return { ok: false, reason: "unavailable" };
  }
  if (answer.success !== true) return { ok: false, reason: "rejected" };
  if (TEST_SECRET.test(configured.secret)) return { ok: true };
  const host = request.host?.split(":")[0]?.toLowerCase();
  return host && answer.hostname === host ? { ok: true } : { ok: false, reason: "rejected" };
}

/** The client IP and host siteverify is checked against, from the incoming request. */
export function turnstileRequest(headers: Headers): { ip: string; host: string | null } {
  return { ip: clientIp(headers), host: headers.get("host") };
}
