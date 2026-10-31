import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFindUnique = vi.fn();
const mockCreate = vi.fn();
const mockUpdate = vi.fn();
const mockFindMany = vi.fn();
const mockAuditCreate = vi.fn();

vi.mock("../db", () => ({
  platformAdmin: {
    store: {
      findUnique: (...args: unknown[]) => mockFindUnique(...args),
      findMany: (...args: unknown[]) => mockFindMany(...args),
    },
  },
  platformAdminTransaction: (fn: (tx: unknown) => unknown) => fn({
    store: {
      findUnique: (...args: unknown[]) => mockFindUnique(...args),
      create: (...args: unknown[]) => mockCreate(...args),
      update: (...args: unknown[]) => mockUpdate(...args),
    },
    auditLog: {
      create: (...args: unknown[]) => mockAuditCreate(...args),
    },
  }),
  authPrisma: {},
}));

vi.mock("../invite/service", () => ({
  createInvite: vi.fn().mockResolvedValue({ id: "inv-1", tokenHash: "hash" }),
}));

vi.mock("../auth", () => ({
  resolveAuthBaseUrl: vi.fn().mockReturnValue("http://localhost:3000"),
}));

vi.mock("../get-store", () => ({
  revalidateStore: vi.fn(),
}));

vi.mock("./session", () => ({
  requirePlatformAdmin: vi.fn().mockResolvedValue({
    user: { id: "admin-1", email: "admin@platform.test", role: "platform_admin", twoFactorEnabled: true },
  }),
}));

import { createStore, updateStore, setStoreStatus } from "./actions";

function formData(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) {
    fd.set(k, v);
  }
  return fd;
}

const VALID_STORE = {
  slug: "mama-ngozi",
  name: "Mama Ngozi African Market",
  themePreset: "palm-and-shea",
  status: "active",
  prepTimeMinutes: "30",
  deliveryRadiusMi: "8",
  minimumOrder: "35",
  autoRefundLimit: "25",
};

describe("createStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects empty slug", async () => {
    const result = await createStore({}, formData({ ...VALID_STORE, slug: "" }));
    expect(result.fieldErrors?.slug).toBeDefined();
  });

  it("lowercases slug before validation", async () => {
    mockFindUnique.mockResolvedValueOnce(null);
    mockCreate.mockResolvedValueOnce({
      id: "store-1",
      slug: "upper",
      name: "Mama Ngozi African Market",
      brandColor: null,
      themePreset: "palm-and-shea",
      status: "active",
    });
    mockAuditCreate.mockResolvedValueOnce({});

    const result = await createStore({}, formData({ ...VALID_STORE, slug: "UPPER" }));
    expect(result.success).toBe(true);
    expect(mockCreate.mock.calls[0][0].data.slug).toBe("upper");
  });

  it("rejects slug starting with hyphen", async () => {
    const result = await createStore({}, formData({ ...VALID_STORE, slug: "-bad" }));
    expect(result.fieldErrors?.slug).toBeDefined();
  });

  it("rejects slug with special characters", async () => {
    const result = await createStore({}, formData({ ...VALID_STORE, slug: "bad slug!" }));
    expect(result.fieldErrors?.slug).toBeDefined();
  });

  it("rejects empty name", async () => {
    const result = await createStore({}, formData({ ...VALID_STORE, name: "" }));
    expect(result.fieldErrors?.name).toBeDefined();
  });

  it("rejects invalid hex color", async () => {
    const result = await createStore(
      {},
      formData({ ...VALID_STORE, brandColor: "red" }),
    );
    expect(result.fieldErrors?.brandColor).toBeDefined();
  });

  it("accepts valid hex color", async () => {
    mockFindUnique.mockResolvedValueOnce(null);
    mockCreate.mockResolvedValueOnce({
      id: "store-1",
      slug: "mama-ngozi",
      name: "Mama Ngozi African Market",
      brandColor: "#1F5A43",
      themePreset: "palm-and-shea",
      status: "active",
    });
    mockAuditCreate.mockResolvedValueOnce({});

    const result = await createStore(
      {},
      formData({ ...VALID_STORE, brandColor: "#1F5A43" }),
    );
    expect(result.success).toBe(true);
  });

  it("rejects duplicate slug", async () => {
    mockFindUnique.mockResolvedValueOnce({ id: "existing", slug: "mama-ngozi" });

    const result = await createStore({}, formData(VALID_STORE));
    expect(result.fieldErrors?.slug).toContain("already exists");
  });

  it("succeeds with valid data and writes audit log", async () => {
    mockFindUnique.mockResolvedValueOnce(null);
    const createdStore = {
      id: "store-1",
      slug: "mama-ngozi",
      name: "Mama Ngozi African Market",
      brandColor: null,
      themePreset: "palm-and-shea",
      status: "active",
    };
    mockCreate.mockResolvedValueOnce(createdStore);
    mockAuditCreate.mockResolvedValueOnce({});

    const result = await createStore({}, formData(VALID_STORE));
    expect(result.success).toBe(true);
    expect(result.storeId).toBe("store-1");
    expect(mockAuditCreate).toHaveBeenCalledOnce();
    expect(mockAuditCreate.mock.calls[0][0].data.action).toBe("store.create");
    expect(mockAuditCreate.mock.calls[0][0].data.actorId).toBe("admin-1");
  });

  it("nudges brand color and reports it", async () => {
    mockFindUnique.mockResolvedValueOnce(null);
    const createdStore = {
      id: "store-1",
      slug: "test-store",
      name: "Test",
      brandColor: "#EEEEEE",
      themePreset: "palm-and-shea",
      status: "active",
    };
    mockCreate.mockResolvedValueOnce(createdStore);
    mockAuditCreate.mockResolvedValueOnce({});

    const result = await createStore(
      {},
      formData({ ...VALID_STORE, slug: "test-store", name: "Test", brandColor: "#EEEEEE" }),
    );
    expect(result.success).toBe(true);
    expect(result.brandColorNudged).toBe(true);
    expect(result.nudgedColor).toBeDefined();
  });

  it("rejects invalid theme preset", async () => {
    const result = await createStore(
      {},
      formData({ ...VALID_STORE, themePreset: "nope" }),
    );
    expect(result.fieldErrors?.themePreset).toBeDefined();
  });

  it("rejects prep time out of range", async () => {
    const result = await createStore(
      {},
      formData({ ...VALID_STORE, prepTimeMinutes: "500" }),
    );
    expect(result.fieldErrors?.prepTimeMinutes).toBeDefined();
  });

  it("rejects delivery radius out of range", async () => {
    const result = await createStore(
      {},
      formData({ ...VALID_STORE, deliveryRadiusMi: "20" }),
    );
    expect(result.fieldErrors?.deliveryRadiusMi).toBeDefined();
  });

  it("rejects invalid hours JSON", async () => {
    const result = await createStore(
      {},
      formData({ ...VALID_STORE, hours: "not json" }),
    );
    expect(result.fieldErrors?.hours).toBeDefined();
  });

  it("accepts zero for minimumOrder", async () => {
    mockFindUnique.mockResolvedValueOnce(null);
    mockCreate.mockResolvedValueOnce({
      id: "store-1",
      slug: "zero-min",
      name: "Zero Min Store",
      brandColor: null,
      themePreset: "palm-and-shea",
      status: "active",
    });
    mockAuditCreate.mockResolvedValueOnce({});

    const result = await createStore(
      {},
      formData({ ...VALID_STORE, slug: "zero-min", name: "Zero Min Store", minimumOrder: "0" }),
    );
    expect(result.success).toBe(true);
    expect(mockCreate.mock.calls[0][0].data.minimumOrderCents).toBe(0);
  });

  it("accepts zero for autoRefundLimit", async () => {
    mockFindUnique.mockResolvedValueOnce(null);
    mockCreate.mockResolvedValueOnce({
      id: "store-1",
      slug: "zero-refund",
      name: "Zero Refund Store",
      brandColor: null,
      themePreset: "palm-and-shea",
      status: "active",
    });
    mockAuditCreate.mockResolvedValueOnce({});

    const result = await createStore(
      {},
      formData({ ...VALID_STORE, slug: "zero-refund", name: "Zero Refund Store", autoRefundLimit: "0" }),
    );
    expect(result.success).toBe(true);
    expect(mockCreate.mock.calls[0][0].data.autoRefundLimitCents).toBe(0);
  });

  it("accepts zero for prepTimeMinutes", async () => {
    mockFindUnique.mockResolvedValueOnce(null);
    mockCreate.mockResolvedValueOnce({
      id: "store-1",
      slug: "zero-prep",
      name: "Zero Prep Store",
      brandColor: null,
      themePreset: "palm-and-shea",
      status: "active",
    });
    mockAuditCreate.mockResolvedValueOnce({});

    const result = await createStore(
      {},
      formData({ ...VALID_STORE, slug: "zero-prep", name: "Zero Prep Store", prepTimeMinutes: "0" }),
    );
    expect(result.success).toBe(true);
    expect(mockCreate.mock.calls[0][0].data.prepTimeMinutes).toBe(0);
  });

  it("accepts zero for deliveryRadiusMi", async () => {
    mockFindUnique.mockResolvedValueOnce(null);
    mockCreate.mockResolvedValueOnce({
      id: "store-1",
      slug: "zero-radius",
      name: "Zero Radius Store",
      brandColor: null,
      themePreset: "palm-and-shea",
      status: "active",
    });
    mockAuditCreate.mockResolvedValueOnce({});

    const result = await createStore(
      {},
      formData({ ...VALID_STORE, slug: "zero-radius", name: "Zero Radius Store", deliveryRadiusMi: "0" }),
    );
    expect(result.success).toBe(true);
    expect(mockCreate.mock.calls[0][0].data.deliveryRadiusMi).toBe(0);
  });

  it("rejects minimumOrder that exceeds INT column max", async () => {
    const result = await createStore(
      {},
      formData({ ...VALID_STORE, minimumOrder: "25000000" }),
    );
    expect(result.fieldErrors?.minimumOrder).toContain("too large");
  });

  it("rejects autoRefundLimit that exceeds INT column max", async () => {
    const result = await createStore(
      {},
      formData({ ...VALID_STORE, autoRefundLimit: "25000000" }),
    );
    expect(result.fieldErrors?.autoRefundLimit).toContain("too large");
  });

  it("rejects non-numeric minimumOrder", async () => {
    const result = await createStore(
      {},
      formData({ ...VALID_STORE, minimumOrder: "abc" }),
    );
    expect(result.fieldErrors?.minimumOrder).toBeDefined();
  });

  it("parses '1e2' correctly as 100 for integer field prepTimeMinutes", async () => {
    mockFindUnique.mockResolvedValueOnce(null);
    mockCreate.mockResolvedValueOnce({
      id: "store-1",
      slug: "sci-prep",
      name: "Sci Prep Store",
      brandColor: null,
      themePreset: "palm-and-shea",
      status: "active",
    });
    mockAuditCreate.mockResolvedValueOnce({});

    const result = await createStore(
      {},
      formData({ ...VALID_STORE, slug: "sci-prep", name: "Sci Prep Store", prepTimeMinutes: "1e2" }),
    );
    expect(result.success).toBe(true);
    expect(mockCreate.mock.calls[0][0].data.prepTimeMinutes).toBe(100);
  });

  it("rejects decimal '12.5' for integer field prepTimeMinutes", async () => {
    const result = await createStore(
      {},
      formData({ ...VALID_STORE, prepTimeMinutes: "12.5" }),
    );
    expect(result.fieldErrors?.prepTimeMinutes).toBeDefined();
  });

  it("rejects non-numeric 'abc' for prepTimeMinutes", async () => {
    const result = await createStore(
      {},
      formData({ ...VALID_STORE, prepTimeMinutes: "abc" }),
    );
    expect(result.fieldErrors?.prepTimeMinutes).toBeDefined();
  });

  it("rejects 'abc' for deliveryRadiusMi", async () => {
    const result = await createStore(
      {},
      formData({ ...VALID_STORE, deliveryRadiusMi: "abc" }),
    );
    expect(result.fieldErrors?.deliveryRadiusMi).toBeDefined();
  });

  it("returns submittedValues alongside fieldErrors", async () => {
    const result = await createStore({}, formData({ ...VALID_STORE, slug: "" }));
    expect(result.fieldErrors?.slug).toBeDefined();
    expect(result.submittedValues).toBeDefined();
    expect(result.submittedValues?.name).toBe("Mama Ngozi African Market");
    expect(result.submittedValues?.slug).toBe("");
  });

  it("includes pickupEnabled in submittedValues on validation error", async () => {
    const result = await createStore({}, formData({ ...VALID_STORE, slug: "", pickupEnabled: "on" }));
    expect(result.fieldErrors?.slug).toBeDefined();
    expect(result.submittedValues?.pickupEnabled).toBe("on");
  });

  it("omits pickupEnabled from submittedValues when unchecked", async () => {
    const result = await createStore({}, formData({ ...VALID_STORE, slug: "" }));
    expect(result.fieldErrors?.slug).toBeDefined();
    expect(result.submittedValues?.pickupEnabled).toBeUndefined();
  });

  it("returns submittedValues on duplicate slug", async () => {
    mockFindUnique.mockResolvedValueOnce({ id: "existing", slug: "mama-ngozi" });
    const result = await createStore({}, formData(VALID_STORE));
    expect(result.fieldErrors?.slug).toContain("already exists");
    expect(result.submittedValues).toBeDefined();
    expect(result.submittedValues?.name).toBe("Mama Ngozi African Market");
  });

  it("rejects reserved slug 'admin'", async () => {
    const result = await createStore({}, formData({ ...VALID_STORE, slug: "admin" }));
    expect(result.fieldErrors?.slug).toContain("reserved");
  });

  it("rejects reserved slug 'www'", async () => {
    const result = await createStore({}, formData({ ...VALID_STORE, slug: "www" }));
    expect(result.fieldErrors?.slug).toContain("reserved");
  });

  it("rejects reserved slug 'api'", async () => {
    const result = await createStore({}, formData({ ...VALID_STORE, slug: "api" }));
    expect(result.fieldErrors?.slug).toContain("reserved");
  });

  it("rejects remote logo URL when LOGO_HOSTS is not set", async () => {
    const original = process.env.LOGO_HOSTS;
    delete process.env.LOGO_HOSTS;
    try {
      const result = await createStore(
        {},
        formData({ ...VALID_STORE, logoUrl: "https://example.com/logo.png" }),
      );
      expect(result.fieldErrors?.logoUrl).toBeDefined();
    } finally {
      if (original !== undefined) process.env.LOGO_HOSTS = original;
    }
  });

  it("rejects protocol-relative logo URL (//host/path)", async () => {
    const result = await createStore(
      {},
      formData({ ...VALID_STORE, logoUrl: "//evil.example.com/logo.png" }),
    );
    expect(result.fieldErrors?.logoUrl).toBeDefined();
    expect(result.fieldErrors?.logoUrl).toContain("Protocol-relative");
  });

  it("accepts local logo path", async () => {
    mockFindUnique.mockResolvedValueOnce(null);
    mockCreate.mockResolvedValueOnce({
      id: "store-1",
      slug: "local-logo",
      name: "Local Logo Store",
      brandColor: null,
      themePreset: "palm-and-shea",
      status: "active",
    });
    mockAuditCreate.mockResolvedValueOnce({});

    const result = await createStore(
      {},
      formData({ ...VALID_STORE, slug: "local-logo", name: "Local Logo Store", logoUrl: "/logos/my-logo.svg" }),
    );
    expect(result.success).toBe(true);
  });

  it("clears hours when input is empty", async () => {
    mockFindUnique.mockResolvedValueOnce(null);
    mockCreate.mockResolvedValueOnce({
      id: "store-1",
      slug: "no-hours",
      name: "No Hours Store",
      brandColor: null,
      themePreset: "palm-and-shea",
      status: "active",
    });
    mockAuditCreate.mockResolvedValueOnce({});

    const result = await createStore(
      {},
      formData({ ...VALID_STORE, slug: "no-hours", name: "No Hours Store", hours: "" }),
    );
    expect(result.success).toBe(true);
    const createArg = mockCreate.mock.calls[0][0].data;
    expect(createArg.hours).toBeDefined();
  });

  it("audit failure propagates (transaction rolls back store creation)", async () => {
    mockFindUnique.mockResolvedValueOnce(null);
    mockCreate.mockResolvedValueOnce({
      id: "store-1",
      slug: "mama-ngozi",
      name: "Mama Ngozi African Market",
      brandColor: null,
      themePreset: "palm-and-shea",
      status: "active",
    });
    mockAuditCreate.mockRejectedValueOnce(new Error("audit insert failed"));

    await expect(createStore({}, formData(VALID_STORE))).rejects.toThrow("audit insert failed");
  });
});

describe("updateStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns error when storeId is missing", async () => {
    const result = await updateStore({}, formData(VALID_STORE));
    expect(result.error).toBeDefined();
  });

  it("returns error when store not found", async () => {
    mockFindUnique.mockResolvedValueOnce(null);
    const result = await updateStore(
      {},
      formData({ ...VALID_STORE, storeId: "nonexistent" }),
    );
    expect(result.error).toContain("not found");
  });

  it("returns submittedValues on validation error", async () => {
    const before = { id: "store-1", slug: "old-slug", name: "Old" };
    mockFindUnique.mockResolvedValueOnce(before);

    const result = await updateStore(
      {},
      formData({ ...VALID_STORE, storeId: "store-1", slug: "" }),
    );
    expect(result.fieldErrors?.slug).toBeDefined();
    expect(result.submittedValues).toBeDefined();
    expect(result.submittedValues?.name).toBe("Mama Ngozi African Market");
  });

  it("detects slug conflict on update", async () => {
    const before = { id: "store-1", slug: "old-slug", name: "Old" };
    mockFindUnique.mockResolvedValueOnce(before);
    mockFindUnique.mockResolvedValueOnce({ id: "store-2", slug: "taken" });

    const result = await updateStore(
      {},
      formData({ ...VALID_STORE, storeId: "store-1", slug: "taken" }),
    );
    expect(result.fieldErrors?.slug).toContain("already exists");
  });

  it("succeeds and writes audit log with before/after", async () => {
    const before = {
      id: "store-1",
      slug: "mama-ngozi",
      name: "Old Name",
      logoUrl: null,
      brandColor: null,
      themePreset: "palm-and-shea",
      status: "active",
      hours: null,
      prepTimeMinutes: 30,
      deliveryRadiusMi: 8,
      minimumOrderCents: 3500,
      pickupEnabled: false,
      autoRefundLimitCents: 2500,
    };
    mockFindUnique.mockResolvedValueOnce(before);

    const updated = {
      ...before,
      name: "Mama Ngozi African Market",
      status: "active",
    };
    mockUpdate.mockResolvedValueOnce(updated);
    mockAuditCreate.mockResolvedValueOnce({});

    const result = await updateStore(
      {},
      formData({ ...VALID_STORE, storeId: "store-1" }),
    );
    expect(result.success).toBe(true);
    expect(mockAuditCreate).toHaveBeenCalledOnce();
    const auditData = mockAuditCreate.mock.calls[0][0].data;
    expect(auditData.action).toBe("store.update");
    expect(auditData.before).toBeDefined();
    expect(auditData.after).toBeDefined();
  });

  it("audit log captures autoRefundLimit change in before/after", async () => {
    const before = {
      id: "store-1",
      slug: "mama-ngozi",
      name: "Mama Ngozi African Market",
      logoUrl: null,
      brandColor: null,
      themePreset: "palm-and-shea",
      status: "active",
      hours: null,
      prepTimeMinutes: 30,
      deliveryRadiusMi: 8,
      minimumOrderCents: 3500,
      pickupEnabled: false,
      autoRefundLimitCents: 2500,
    };
    mockFindUnique.mockResolvedValueOnce(before);

    const updated = { ...before, autoRefundLimitCents: 5000 };
    mockUpdate.mockResolvedValueOnce(updated);
    mockAuditCreate.mockResolvedValueOnce({});

    const result = await updateStore(
      {},
      formData({ ...VALID_STORE, storeId: "store-1", autoRefundLimit: "50" }),
    );
    expect(result.success).toBe(true);
    const auditData = mockAuditCreate.mock.calls[0][0].data;
    expect(auditData.before.autoRefundLimitCents).toBe(2500);
    expect(auditData.after.autoRefundLimitCents).toBe(5000);
  });

  it("audit failure propagates (transaction rolls back store update)", async () => {
    const before = {
      id: "store-1",
      slug: "mama-ngozi",
      name: "Old Name",
      logoUrl: null,
      brandColor: null,
      themePreset: "palm-and-shea",
      status: "active",
      hours: null,
      prepTimeMinutes: 30,
      deliveryRadiusMi: 8,
      minimumOrderCents: 3500,
      pickupEnabled: false,
      autoRefundLimitCents: 2500,
    };
    mockFindUnique.mockResolvedValueOnce(before);
    mockUpdate.mockResolvedValueOnce({ ...before, name: "Mama Ngozi African Market" });
    mockAuditCreate.mockRejectedValueOnce(new Error("audit insert failed"));

    await expect(
      updateStore({}, formData({ ...VALID_STORE, storeId: "store-1" })),
    ).rejects.toThrow("audit insert failed");
  });
});

describe("setStoreStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns error when store not found", async () => {
    mockFindUnique.mockResolvedValueOnce(null);
    const result = await setStoreStatus("nonexistent", "suspended");
    expect(result.error).toContain("not found");
  });

  it("suspends an active store and writes audit log", async () => {
    const before = { id: "store-1", slug: "mama-ngozi", status: "active" };
    mockFindUnique.mockResolvedValueOnce(before);
    mockUpdate.mockResolvedValueOnce({ ...before, status: "suspended" });
    mockAuditCreate.mockResolvedValueOnce({});

    const result = await setStoreStatus("store-1", "suspended");
    expect(result.success).toBe(true);
    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: "store-1" },
      data: { status: "suspended" },
    });
    const auditData = mockAuditCreate.mock.calls[0][0].data;
    expect(auditData.action).toBe("store.suspend");
    expect(auditData.before).toEqual({ status: "active" });
    expect(auditData.after).toEqual({ status: "suspended" });
  });

  it("reactivates a suspended store", async () => {
    const before = { id: "store-1", slug: "mama-ngozi", status: "suspended" };
    mockFindUnique.mockResolvedValueOnce(before);
    mockUpdate.mockResolvedValueOnce({ ...before, status: "active" });
    mockAuditCreate.mockResolvedValueOnce({});

    const result = await setStoreStatus("store-1", "active");
    expect(result.success).toBe(true);
    const auditData = mockAuditCreate.mock.calls[0][0].data;
    expect(auditData.action).toBe("store.unsuspend");
  });

  it("is idempotent: setting suspended on an already-suspended store is a no-op", async () => {
    mockFindUnique.mockResolvedValueOnce({ id: "store-1", slug: "mama-ngozi", status: "suspended" });

    const result = await setStoreStatus("store-1", "suspended");
    expect(result.success).toBe(true);
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockAuditCreate).not.toHaveBeenCalled();
  });

  it("is idempotent: setting active on an already-active store is a no-op", async () => {
    mockFindUnique.mockResolvedValueOnce({ id: "store-1", slug: "mama-ngozi", status: "active" });

    const result = await setStoreStatus("store-1", "active");
    expect(result.success).toBe(true);
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockAuditCreate).not.toHaveBeenCalled();
  });

  it("two-tab case: two suspend calls leave the store suspended", async () => {
    mockFindUnique.mockResolvedValueOnce({ id: "store-1", slug: "mama-ngozi", status: "active" });
    mockUpdate.mockResolvedValueOnce({ id: "store-1", slug: "mama-ngozi", status: "suspended" });
    mockAuditCreate.mockResolvedValueOnce({});

    const result1 = await setStoreStatus("store-1", "suspended");
    expect(result1.success).toBe(true);

    mockFindUnique.mockResolvedValueOnce({ id: "store-1", slug: "mama-ngozi", status: "suspended" });

    const result2 = await setStoreStatus("store-1", "suspended");
    expect(result2.success).toBe(true);
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockAuditCreate).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid targetStatus at runtime", async () => {
    const result = await setStoreStatus("store-1", "deleted" as "suspended");
    expect(result.error).toContain("Invalid status");
  });

  it("audit failure propagates (transaction rolls back status change)", async () => {
    mockFindUnique.mockResolvedValueOnce({ id: "store-1", slug: "mama-ngozi", status: "active" });
    mockUpdate.mockResolvedValueOnce({ id: "store-1", slug: "mama-ngozi", status: "suspended" });
    mockAuditCreate.mockRejectedValueOnce(new Error("audit insert failed"));

    await expect(setStoreStatus("store-1", "suspended")).rejects.toThrow("audit insert failed");
  });
});
