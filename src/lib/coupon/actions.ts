"use server";

import { z } from "zod";
import { requireStoreOwner } from "../store-admin/session";
import { parseInput } from "../security/parse-input";
import { parseCouponForm } from "./form";
import { COUPON_NOT_FOUND, createCoupon, setCouponActive, updateCoupon, type CouponActor, type CouponResult } from "./service";

const couponIdSchema = z.string().min(1).max(200);

async function ownerActor(): Promise<{ actor: CouponActor; timeZone: string }> {
  const session = await requireStoreOwner();
  return {
    actor: { storeId: session.store.id, actorId: session.user.id, actorEmail: session.user.email },
    timeZone: session.store.timezone,
  };
}

export async function createCouponAction(formData: FormData): Promise<CouponResult> {
  const { actor, timeZone } = await ownerActor();
  const input = parseCouponForm(formData, timeZone);
  if (!input.ok) return input;
  return createCoupon(actor, input.data);
}

export async function updateCouponAction(couponId: string, formData: FormData): Promise<CouponResult> {
  const { actor, timeZone } = await ownerActor();
  const id = parseInput(couponIdSchema, couponId);
  if (!id.ok) return { ok: false, error: COUPON_NOT_FOUND };
  const input = parseCouponForm(formData, timeZone);
  if (!input.ok) return input;
  return updateCoupon(actor, id.data, input.data);
}

export async function setCouponActiveAction(couponId: string, active: boolean): Promise<CouponResult> {
  const { actor } = await ownerActor();
  const id = parseInput(couponIdSchema, couponId);
  const flag = parseInput(z.boolean(), active);
  if (!id.ok || !flag.ok) return { ok: false, error: COUPON_NOT_FOUND };
  return setCouponActive(actor, id.data, flag.data);
}
