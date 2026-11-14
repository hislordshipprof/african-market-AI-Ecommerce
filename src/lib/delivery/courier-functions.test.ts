import { afterEach, describe, expect, it, vi } from "vitest";
import { inngest } from "../inngest/client";
import { emitCourierEvent } from "./courier-functions";
import { COURIER_BOTH_FAILED, COURIER_DELIVERY_CREATED } from "./dispatch";

describe("emitCourierEvent", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("a failed send of the timer event reaches the caller; a failed notification send is only logged", async () => {
    vi.stubEnv("INNGEST_EVENT_KEY", "test-key");
    vi.spyOn(inngest, "send").mockRejectedValue(new Error("inngest down"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(emitCourierEvent({ name: COURIER_DELIVERY_CREATED, data: { storeId: "s1", deliveryId: "d1" } })).rejects.toThrow("inngest down");
    await expect(
      emitCourierEvent({ name: COURIER_BOTH_FAILED, data: { storeId: "s1", orderId: "o1", orderNumber: 1, options: ["cancel"] } }),
    ).resolves.toBeUndefined();
  });
});
