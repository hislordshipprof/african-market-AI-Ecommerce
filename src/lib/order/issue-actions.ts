"use server";

import { headers } from "next/headers";
import { z } from "zod";
import { getStore } from "../get-store";
import { parseInput } from "../security/parse-input";
import { takeRateLimit } from "../rate-limit/app-limiter";
import { clientIp } from "../assistant/client-ip";
import { DELIVERY_PROOF_MAX_BYTES } from "./delivery-proof";
import { ISSUE_LINES_INVALID, ISSUE_PHOTO_INVALID, ISSUE_TYPES, submitIssueReport, type IssueState } from "./issue-report";

const reportSchema = z.strictObject({
  token: z.string().min(1).max(200),
  type: z.enum(ISSUE_TYPES),
  lines: z.array(z.strictObject({ lineId: z.string().min(1).max(64), qty: z.number().int().min(1).max(999) })).min(1).max(100),
  note: z.string().trim().max(1000).nullable(),
});
const TOKEN_LIMIT = 5;
const IP_LIMIT = 20;
const WINDOW_MS = 60 * 60 * 1000;
const TOO_MANY = "Too many tries. Wait a while, then try again.";

export type ReportIssueResult = { ok: true; state: IssueState } | { ok: false; error: string } | null;

/** Public: the tracking token is the only credential, so it is rate limited per token and per IP. */
export async function reportIssueAction(_previous: ReportIssueResult, form: FormData): Promise<ReportIssueResult> {
  const lines: Array<{ lineId: string; qty: number }> = [];
  for (const [name, value] of form.entries()) {
    if (!name.startsWith("qty:") || typeof value !== "string" || value === "" || value === "0") continue;
    lines.push({ lineId: name.slice(4), qty: Number(value) });
  }
  const note = form.get("note");
  const parsed = parseInput(reportSchema, {
    token: form.get("token"),
    type: form.get("type"),
    lines,
    note: typeof note === "string" && note.trim() ? note : null,
  });
  if (!parsed.ok) return { ok: false, error: ISSUE_LINES_INVALID };
  const photo = form.get("photo");
  const file = photo instanceof File && photo.size > 0 ? photo : null;
  if (!file || file.size > DELIVERY_PROOF_MAX_BYTES) return { ok: false, error: ISSUE_PHOTO_INVALID };

  const ip = clientIp(await headers());
  const [byToken, byIp] = await Promise.all([
    takeRateLimit(`issue-report:token:${parsed.data.token}`, TOKEN_LIMIT, WINDOW_MS),
    takeRateLimit(`issue-report:ip:${ip}`, IP_LIMIT, WINDOW_MS),
  ]);
  if (!byToken.ok || !byIp.ok) return { ok: false, error: TOO_MANY };

  const store = await getStore();
  return submitIssueReport(store, parsed.data.token, {
    type: parsed.data.type,
    lines: parsed.data.lines,
    note: parsed.data.note,
    photo: new Uint8Array(await file.arrayBuffer()),
  });
}
