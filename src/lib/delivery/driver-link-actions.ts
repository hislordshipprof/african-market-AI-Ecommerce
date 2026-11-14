"use server";

import { z } from "zod";
import { getStore } from "@/lib/get-store";
import { parseInput } from "@/lib/security/parse-input";
import { driverMarkDelivered, driverMarkOutForDelivery } from "@/lib/delivery/driver-route";
import {
  DELIVERY_PROOF_MAX_BYTES,
  PROOF_PHOTO_MISSING,
  PROOF_PHOTO_NOT_IMAGE,
  PROOF_PHOTO_TOO_LARGE,
  PROOF_STORAGE_NOT_SET_UP,
} from "@/lib/order/delivery-proof";

const ROUTE_ENDED = "This route link no longer works. Ask the store for a new one";
const TRY_AGAIN = "That did not go through. Try again";
const SHOWN = new Set([PROOF_PHOTO_MISSING, PROOF_PHOTO_NOT_IMAGE, PROOF_PHOTO_TOO_LARGE, PROOF_STORAGE_NOT_SET_UP]);
const idSchema = z.string().min(1).max(200);

type Result = { ok: true } | { ok: false; error: string };

function shown(result: Result): Result {
  if (result.ok) return result;
  if (result.error === "not_found") return { ok: false, error: ROUTE_ENDED };
  if (SHOWN.has(result.error)) return result;
  // A status refusal means someone else already moved the order on; reloading shows where it stands.
  return { ok: false, error: TRY_AGAIN };
}

export async function driverOutForDeliveryAction(token: string, orderId: string): Promise<Result> {
  const t = parseInput(idSchema, token);
  const id = parseInput(idSchema, orderId);
  if (!t.ok || !id.ok) return { ok: false, error: ROUTE_ENDED };
  const store = await getStore();
  try {
    return shown(await driverMarkOutForDelivery(store.id, t.data, id.data));
  } catch {
    return { ok: false, error: TRY_AGAIN };
  }
}

/** FormData: `token`, `orderId` and the `photo` file. The service checks the photo's bytes. */
export async function driverDeliveredAction(form: FormData): Promise<Result> {
  const t = parseInput(idSchema, form.get("token"));
  const id = parseInput(idSchema, form.get("orderId"));
  if (!t.ok || !id.ok) return { ok: false, error: ROUTE_ENDED };
  const photo = form.get("photo");
  const file = photo instanceof File && photo.size > 0 ? photo : null;
  if (file && file.size > DELIVERY_PROOF_MAX_BYTES) return { ok: false, error: PROOF_PHOTO_TOO_LARGE };
  const store = await getStore();
  try {
    return shown(await driverMarkDelivered(store.id, t.data, id.data, file ? new Uint8Array(await file.arrayBuffer()) : null));
  } catch {
    return { ok: false, error: TRY_AGAIN };
  }
}
