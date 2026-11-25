import { describe, expect, it } from "vitest";
import { composerKeySends, dockOpenRequested, launcherLift, nearLatest, withoutDockParam } from "./dock";

describe("composerKeySends", () => {
  it("sends on Enter, keeps Shift+Enter and an IME's Enter as a new line or composition", () => {
    expect(composerKeySends({ key: "Enter", shiftKey: false, isComposing: false })).toBe(true);
    expect(composerKeySends({ key: "Enter", shiftKey: true, isComposing: false })).toBe(false);
    expect(composerKeySends({ key: "Enter", shiftKey: false, isComposing: true })).toBe(false);
    expect(composerKeySends({ key: "a", shiftKey: false, isComposing: false })).toBe(false);
  });
});

describe("nearLatest", () => {
  it("is true at or near the bottom of the thread, false once the reader has scrolled up", () => {
    expect(nearLatest({ scrollTop: 600, clientHeight: 400, scrollHeight: 1000 })).toBe(true);
    expect(nearLatest({ scrollTop: 570, clientHeight: 400, scrollHeight: 1000 })).toBe(true);
    expect(nearLatest({ scrollTop: 200, clientHeight: 400, scrollHeight: 1000 })).toBe(false);
    expect(nearLatest({ scrollTop: 0, clientHeight: 400, scrollHeight: 300 })).toBe(true);
  });
});

describe("dock URL", () => {
  it("opens only for assistant=open and strips just that parameter", () => {
    expect(dockOpenRequested("?assistant=open")).toBe(true);
    expect(dockOpenRequested("?store=x&assistant=open")).toBe(true);
    expect(dockOpenRequested("?assistant=1")).toBe(false);
    expect(dockOpenRequested("")).toBe(false);
    expect(withoutDockParam("/admin", "?assistant=open")).toBe("/admin");
    expect(withoutDockParam("/store-admin", "?store=x&assistant=open")).toBe("/store-admin?store=x");
  });
});

describe("launcherLift", () => {
  it("lifts the button above a bar fixed or stuck to the bottom of the screen, and ignores bars elsewhere", () => {
    expect(launcherLift([], 800)).toBe(0);
    expect(launcherLift([{ top: 720, bottom: 800 }], 800)).toBe(80);
    expect(launcherLift([{ top: 700, bottom: 790 }, { top: 740, bottom: 800 }], 800)).toBe(100);
    expect(launcherLift([{ top: 200, bottom: 280 }], 800)).toBe(0);
    expect(launcherLift([{ top: 900, bottom: 980 }], 800)).toBe(0);
  });
});
