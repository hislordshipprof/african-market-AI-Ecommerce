"use server";

import { z } from "zod";
import { requireStoreOwner, type StoreSession } from "../store-admin/session";
import { parseInput } from "../security/parse-input";
import { parseCouponForm } from "./form";
import { COUPON_NOT_FOUND, createCoupon, setCouponActive, updateCoupon, type CouponActor, type CouponResult } from "./service";

const couponIdSchema = z.string().min(1).max(200);

function actorOf(session: StoreSession): CouponActor {
  return { storeId: session.store.id, actorId: session.user.id, actorEmail: session.user.email };
}

export async function createCouponAction(formData: FormData): Promise<CouponResult> {
  const session = await requireStoreOwner();
  const input = parseCouponForm(formData, session.store.timezone);
  if (!input.ok) return input;
  return createCoupon(actorOf(session), input.data);
}

export async function updateCouponAction(couponId: string, formData: FormData): Promise<CouponResult> {
  const session = await requireStoreOwner();
  const id = parseInput(couponIdSchema, couponId);
  if (!id.ok) return { ok: false, error: COUPON_NOT_FOUND };
  const input = parseCouponForm(formData, session.store.timezone);
  if (!input.ok) return input;
  return updateCoupon(actorOf(session), id.data, input.data);
}

export async function setCouponActiveAction(couponId: string, active: boolean): Promise<CouponResult> {
  const session = await requireStoreOwner();
  const id = parseInput(couponIdSchema, couponId);
  const flag = parseInput(z.boolean(), active);
  if (!id.ok || !flag.ok) return { ok: false, error: COUPON_NOT_FOUND };
  return setCouponActive(actorOf(session), id.data, flag.data);
}
