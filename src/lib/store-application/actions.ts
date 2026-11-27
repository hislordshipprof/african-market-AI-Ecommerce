"use server";

import { headers } from "next/headers";
import { z } from "zod";
import { clientIp } from "../assistant/client-ip";
import { parseInput, readFormField, readFormFields } from "../security/parse-input";
import { TURNSTILE_FAILED, TURNSTILE_FIELD, turnstileRequest, verifyTurnstile } from "../security/turnstile";
import { APPLICATION_FIELDS } from "./fields";
import { submitStoreApplication } from "./service";

export type SellFormState =
  | { status: "idle" }
  | { status: "sent" }
  | { status: "error"; message: string; fieldErrors: Record<string, string>; values: Record<string, string> };

const fieldsSchema = z.record(z.string(), z.string().max(1000).nullable());

/** The public /sell form (#554). Only the root domain serves it; store hosts get no application form. */
export async function submitStoreApplicationAction(_previous: SellFormState, form: FormData): Promise<SellFormState> {
  const incoming = await headers();
  const parsed = parseInput(fieldsSchema, readFormFields(form, APPLICATION_FIELDS));
  const values: Record<string, string> = {};
  if (parsed.ok) {
    for (const [key, value] of Object.entries(parsed.data)) if (key !== "fax" && value) values[key] = value;
  }
  if (incoming.get("x-platform-root") !== "1") {
    return { status: "error", message: "Applications are taken on the Globe Grocer home site.", fieldErrors: {}, values };
  }
  if (!parsed.ok) return { status: "error", message: "Check the form and try again.", fieldErrors: {}, values };
  // Fails closed: with siteverify unreachable no application is taken (#872).
  const human = await verifyTurnstile(readFormField(form, TURNSTILE_FIELD), turnstileRequest(incoming));
  if (!human.ok) return { status: "error", message: TURNSTILE_FAILED, fieldErrors: {}, values };

  try {
    const result = await submitStoreApplication(parsed.data, clientIp(incoming));
    if (result.ok) return { status: "sent" };
    if ("rateLimited" in result) {
      return { status: "error", message: "Too many applications from this network. Try again in an hour.", fieldErrors: {}, values };
    }
    return { status: "error", message: "Check the highlighted fields.", fieldErrors: result.fieldErrors, values };
  } catch (err) {
    console.error(JSON.stringify({ event: "store_application_submit_failed", message: err instanceof Error ? err.message : "failed" }));
    return { status: "error", message: "Something went wrong on our side. Please try again.", fieldErrors: {}, values };
  }
}
