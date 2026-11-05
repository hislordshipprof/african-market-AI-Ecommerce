import { describe, expect, it } from "vitest";
import { clientIp } from "./client-ip";

describe("client ip", () => {
  it("uses the first x-forwarded-for entry then x-real-ip then unknown", () => {
    expect(clientIp(new Headers({ "x-forwarded-for": "1.1.1.1, 2.2.2.2" }))).toBe("1.1.1.1");
    expect(clientIp(new Headers({ "x-real-ip": "9.9.9.9" }))).toBe("9.9.9.9");
    expect(clientIp(new Headers())).toBe("unknown");
  });
});
