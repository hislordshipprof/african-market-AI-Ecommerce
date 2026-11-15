"use server";

import { z } from "zod";
import { READ_ONLY_MESSAGE, requireStoreMember, requireStoreWriter } from "../store-admin/session";
import { parseInput } from "../security/parse-input";
import { STAFF_GENERIC_ERROR } from "../order/staff-copy";
import { assignDriverRoute, driverRouteBoard, revokeDriverRoute, ROUTE_NOT_FOUND } from "./driver-route";

const assignSchema = z.object({
  slot: z.string().min(1).max(40),
  driverName: z.string().max(200),
  driverPhone: z.string().max(40),
});

export async function assignDriverRouteAction(input: { slot: string; driverName: string; driverPhone: string }) {
  const session = await requireStoreWriter();
  if (!session) return { ok: false as const, error: READ_ONLY_MESSAGE };
  const parsed = parseInput(assignSchema, input);
  if (!parsed.ok) return { ok: false as const, error: STAFF_GENERIC_ERROR };
  try {
    return await assignDriverRoute(session.store.id, parsed.data);
  } catch (err) {
    console.error(JSON.stringify({ event: "driver_route_assign_failed", message: err instanceof Error ? err.name : "unknown" }));
    return { ok: false as const, error: STAFF_GENERIC_ERROR };
  }
}

export async function revokeDriverRouteAction(routeId: string) {
  const session = await requireStoreWriter();
  if (!session) return { ok: false as const, error: READ_ONLY_MESSAGE };
  const id = parseInput(z.string().min(1).max(200), routeId);
  if (!id.ok) return { ok: false as const, error: ROUTE_NOT_FOUND };
  return revokeDriverRoute(session.store.id, id.data);
}

export async function driverRouteBoardAction() {
  const session = await requireStoreMember();
  return driverRouteBoard(session.store.id, session.store.timezone);
}
