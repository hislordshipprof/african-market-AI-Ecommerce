import { Prisma } from "@prisma/client";
import { lockStoreRow, storeScopedTransaction } from "../db";
import type { CouponInput } from "./form";

export interface CouponActor {
  storeId: string;
  actorId: string;
  actorEmail: string;
}

export type CouponResult = { ok: true } | { ok: false; error: string };

export const COUPON_NOT_FOUND = "Coupon not found.";
export const COUPON_VALUE_LOCKED = "This code has been used, so its type and value cannot change. Deactivate it and create a new one.";

/** Orders in these states gave no discount: the use was released. */
const RELEASED_STATUSES = ["CANCELLING", "CANCELLED"];

const AUDITED = ["code", "kind", "percentOff", "amountOffCents", "minGoodsCents", "startsAt", "endsAt", "totalUses", "usesPerCustomer", "firstOrderOnly"] as const;

function snapshot(coupon: CouponInput): Prisma.InputJsonObject {
  const out: Record<string, Prisma.InputJsonValue | null> = {};
  for (const key of AUDITED) {
    const value = coupon[key];
    out[key] = value instanceof Date ? value.toISOString() : value;
  }
  return out;
}

function duplicateCode(code: string): CouponResult {
  return { ok: false, error: `Your store already has the code ${code}.` };
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

export async function listCoupons(storeId: string) {
  return storeScopedTransaction(storeId, async (tx) => {
    const coupons = await tx.storeCoupon.findMany({ orderBy: [{ active: "desc" }, { createdAt: "desc" }] });
    const usage = await tx.order.groupBy({
      by: ["couponId"],
      where: { couponId: { not: null }, status: { notIn: RELEASED_STATUSES } },
      _count: { _all: true },
      _sum: { discountCents: true },
    });
    const byCoupon = new Map(usage.map((u) => [u.couponId, u]));
    return coupons.map((c) => ({
      ...c,
      usesSoFar: byCoupon.get(c.id)?._count._all ?? 0,
      discountGivenCents: byCoupon.get(c.id)?._sum.discountCents ?? 0,
    }));
  });
}

export async function createCoupon(actor: CouponActor, input: CouponInput): Promise<CouponResult> {
  try {
    return await storeScopedTransaction(actor.storeId, async (tx) => {
      const coupon = await tx.storeCoupon.create({
        data: { ...input, storeId: actor.storeId, createdById: actor.actorId },
      });
      await tx.auditLog.create({
        data: {
          storeId: actor.storeId,
          actorId: actor.actorId,
          actorEmail: actor.actorEmail,
          action: "coupon.create",
          entityType: "store_coupon",
          entityId: coupon.id,
          after: { ...snapshot(input), active: true },
        },
      });
      return { ok: true as const };
    });
  } catch (err) {
    if (isUniqueViolation(err)) return duplicateCode(input.code);
    throw err;
  }
}

export async function updateCoupon(actor: CouponActor, couponId: string, input: CouponInput): Promise<CouponResult> {
  try {
    return await storeScopedTransaction(actor.storeId, async (tx) => {
      // The same lock checkout takes to reserve a use (#557), so a use cannot land mid-edit.
      await lockStoreRow(tx, actor.storeId);
      const current = await tx.storeCoupon.findUnique({ where: { id: couponId } });
      if (!current) return { ok: false as const, error: COUPON_NOT_FOUND };

      const valueChanged = current.kind !== input.kind
        || current.percentOff !== input.percentOff
        || current.amountOffCents !== input.amountOffCents;
      if (valueChanged && (await tx.order.count({ where: { couponId } })) > 0) {
        return { ok: false as const, error: COUPON_VALUE_LOCKED };
      }

      await tx.storeCoupon.update({ where: { id: couponId }, data: input });
      await tx.auditLog.create({
        data: {
          storeId: actor.storeId,
          actorId: actor.actorId,
          actorEmail: actor.actorEmail,
          action: "coupon.update",
          entityType: "store_coupon",
          entityId: couponId,
          before: snapshot(current as CouponInput),
          after: snapshot(input),
        },
      });
      return { ok: true as const };
    });
  } catch (err) {
    if (isUniqueViolation(err)) return duplicateCode(input.code);
    throw err;
  }
}

export async function setCouponActive(actor: CouponActor, couponId: string, active: boolean): Promise<CouponResult> {
  return storeScopedTransaction(actor.storeId, async (tx) => {
    const current = await tx.storeCoupon.findUnique({ where: { id: couponId }, select: { active: true } });
    if (!current) return { ok: false as const, error: COUPON_NOT_FOUND };
    if (current.active === active) return { ok: true as const };
    await tx.storeCoupon.update({ where: { id: couponId }, data: { active } });
    await tx.auditLog.create({
      data: {
        storeId: actor.storeId,
        actorId: actor.actorId,
        actorEmail: actor.actorEmail,
        action: active ? "coupon.activate" : "coupon.deactivate",
        entityType: "store_coupon",
        entityId: couponId,
        before: { active: current.active },
        after: { active },
      },
    });
    return { ok: true as const };
  });
}
