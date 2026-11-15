import { randomUUID } from "crypto";
import { z } from "zod";
import { directoryRequestCounts, findDirectoryRequestMatches, insertDirectoryStoreRequest, markDirectoryRequestNotified, nearestPlacesInState, platform, type DirectoryRequestCount, type DirectoryRequestMatch } from "../db";
import { normalizeEmail } from "../email";
import { sendEmail } from "../email/send";
import { escapeHtml } from "../format";
import { normalizeUsPhone } from "../notifications/phone";
import { smsSender } from "../notifications/sms";
import { sendSkipped, sendWithTimeout } from "../inngest/notify";
import { takeRateLimit } from "../rate-limit/app-limiter";
import { parseInput } from "../security/parse-input";
import { directoryLink } from "./attribution";
import { NEARBY_MILES } from "./distance";
import { storefrontUrl } from "./links";
import { STORE_REQUEST_CONSENT } from "./store-request-consent";
import { STATE_NAMES, type StateCode } from "./us-states";
import { zipState } from "./zip-state";


const HOUR_MS = 60 * 60_000;
export const REQUEST_BROWSER_LIMIT = 5;
const REQUEST_IP_LIMIT = 20;
const BATCH = 50;

export const storeRequestInput = z.strictObject({
  zip: z.string().max(10),
  contact: z.string().max(254),
  consent: z.literal(true),
  // A field people never see. Bots fill it in.
  website: z.string().max(200),
});

export type ParsedRequest =
  | { ok: true; zip: string; email: string | null; phone: string | null }
  | { ok: false; spam: true }
  | { ok: false; spam?: undefined; message: string };

export type RequestResult = { ok: true } | { ok: false; message: string };

export const STORE_REQUEST_BAD = "Enter a 5-digit ZIP code, an email or US mobile number, and tick the box.";

export function parseStoreRequest(input: unknown): ParsedRequest {
  const parsed = parseInput(storeRequestInput, input);
  if (!parsed.ok) return { ok: false, message: STORE_REQUEST_BAD };
  if (parsed.data.website !== "") return { ok: false, spam: true };
  const zip = /^(\d{5})(-\d{4})?$/.exec(parsed.data.zip.trim())?.[1];
  if (!zip) return { ok: false, message: "Enter a 5-digit ZIP code." };
  const contact = parsed.data.contact.trim();
  if (contact.includes("@")) {
    const email = z.email().safeParse(normalizeEmail(contact));
    return email.success ? { ok: true, zip, email: email.data, phone: null } : { ok: false, message: "Check the email address." };
  }
  const phone = normalizeUsPhone(contact);
  return phone.ok ? { ok: true, zip, email: null, phone: phone.e164 } : { ok: false, message: "Enter an email or a US mobile number." };
}

/** Public: a shopper with no store near them asks to hear when one opens (#455). The answer never says whether the contact was already on file. */
export async function submitStoreRequest(input: unknown, client: { ip: string; browser: string | null }): Promise<RequestResult> {
  const parsed = parseStoreRequest(input);
  if (!parsed.ok && parsed.spam) return { ok: true };
  if (!parsed.ok) return parsed;

  const [byBrowser, byIp] = await Promise.all([
    takeRateLimit(`directory-request:browser:${client.browser ?? "missing"}`, REQUEST_BROWSER_LIMIT, HOUR_MS),
    takeRateLimit(`directory-request:ip:${client.ip}`, REQUEST_IP_LIMIT, HOUR_MS),
  ]);
  if (!byBrowser.ok || !byIp.ok) return { ok: false, message: "Too many requests. Try again in an hour." };

  const known = await platform.gazetteerZip.findUnique({ where: { zip: parsed.zip }, select: { zip: true } });
  if (!known) return { ok: false, message: "We don't have that ZIP code on our map. Try a nearby one." };

  await insertDirectoryStoreRequest({ id: randomUUID(), zip: parsed.zip, email: parsed.email, phone: parsed.phone, consentText: STORE_REQUEST_CONSENT });
  return { ok: true };
}

type OpenedStore = { name: string; city: string | null; state: string | null; distanceMi: number; href: string };

const placeOf = (store: OpenedStore) => [store.city, store.state].filter(Boolean).join(", ");

export function storeOpenedEmail(zip: string, store: OpenedStore): { subject: string; html: string } {
  const place = placeOf(store);
  const name = escapeHtml(store.name);
  return {
    subject: `A store is open near ${zip}`,
    html: [
      `<p><a href="${escapeHtml(store.href)}">${name}</a>${place ? ` in ${escapeHtml(place)}` : ""} is now on African Markets, ${store.distanceMi.toFixed(1)} miles from ${zip}. You can order pickup or delivery straight from the store.</p>`,
      `<p>You asked us to tell you when a store opened near you. This is the only message we will send, and we have deleted your email address.</p>`,
    ].join(""),
  };
}

export function storeOpenedText(zip: string, store: OpenedStore): string {
  const place = placeOf(store);
  return `${store.name}${place ? ` (${place})` : ""} is open on African Markets, ${store.distanceMi.toFixed(1)} mi from ${zip}: ${store.href} This is the only text we will send.`;
}

function storeHref(slug: string, env: Record<string, string | undefined> = process.env): string | null {
  const root = env.PLATFORM_ROOT_DOMAIN ?? "";
  if (!root) return null;
  const href = storefrontUrl(slug, root, root === "localhost" && env.PORT ? `localhost:${env.PORT}` : root);
  return href ? directoryLink(href) : null;
}

async function sendOne(match: DirectoryRequestMatch, href: string): Promise<boolean> {
  const store = { name: match.name, city: match.city, state: match.state, distanceMi: Number(match.distance), href };
  // Same key on every retry, so a crash between the send and the mark cannot send twice within the provider's window.
  const idempotencyKey = `directory-request-${match.id}`;
  if (match.email) {
    await sendEmail({ to: match.email, ...storeOpenedEmail(match.zip, store), idempotencyKey });
    return true;
  }
  const sms = smsSender();
  if (!sms || !match.phone) return false;
  await sms.send({ to: match.phone, from: process.env.TELNYX_FROM_NUMBER ?? "test-from", text: storeOpenedText(match.zip, store) }, { idempotencyKey });
  return true;
}

export const STORE_LISTED = "directory/store.listed";

/** A store just went into the directory: run the notices now. A failed send is logged, never thrown; the daily run catches up. */
export async function queueStoreRequestNotices(storeId: string): Promise<void> {
  if (sendSkipped()) return;
  try {
    await sendWithTimeout({ name: STORE_LISTED, data: { storeId } });
  } catch (err) {
    console.error(JSON.stringify({ event: "inngest_send_failed", name: STORE_LISTED, storeId, message: err instanceof Error ? err.message : "send failed" }));
  }
}

export type NotifyResult = { sent: number; failed: number; skipped: number };

/**
 * One message per waiting request that now has a listed store within 50 miles, nearest store named (#455).
 * Send first, then mark: a run that dies in between leaves the request waiting, and the retry reuses the key.
 */
export async function notifyWaitingRequests(): Promise<NotifyResult> {
  const result: NotifyResult = { sent: 0, failed: 0, skipped: 0 };
  let cursor = "";
  while (true) {
    const matches = await findDirectoryRequestMatches(cursor, NEARBY_MILES, BATCH);
    for (const match of matches) {
      const href = storeHref(match.slug);
      try {
        if (!href || !(await sendOne(match, href))) {
          result.skipped += 1;
          continue;
        }
        if (await markDirectoryRequestNotified(match.id, match.storeId)) result.sent += 1;
      } catch (error) {
        result.failed += 1;
        console.error(JSON.stringify({ event: "directory_request_notify_failed", requestId: match.id, message: error instanceof Error ? error.message : String(error) }));
      }
    }
    if (matches.length < BATCH) return result;
    cursor = matches[matches.length - 1]!.id;
  }
}

export type RequestArea = { state: StateCode; zips: (DirectoryRequestCount & { place: string | null })[] };

/** Platform admin view: request counts by state (from the ZIP prefix), then ZIP with its nearest place in that state. */
export async function requestsByArea(): Promise<RequestArea[]> {
  const counts = await directoryRequestCounts();
  const located = counts.flatMap((count) => {
    const state = zipState(count.zip);
    return state ? [{ ...count, state }] : [];
  });
  const places = await nearestPlacesInState(located);
  const byState = new Map<StateCode, RequestArea>();
  for (const { state, ...count } of located) {
    const area = byState.get(state) ?? { state, zips: [] };
    area.zips.push({ ...count, place: places.get(count.zip) ?? null });
    byState.set(state, area);
  }
  const areas = [...byState.values()].sort((a, b) => STATE_NAMES[a.state].localeCompare(STATE_NAMES[b.state]));
  for (const area of areas) area.zips.sort((a, b) => b.waiting - a.waiting || a.zip.localeCompare(b.zip));
  return areas;
}
