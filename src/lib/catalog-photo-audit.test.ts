import { afterEach, describe, expect, it, vi } from "vitest";
import { auditCatalogPhotos, type AuditProduct, type HeadResult } from "./catalog-photo-audit";

function product(partial: Partial<AuditProduct> & Pick<AuditProduct, "id" | "name">): AuditProduct {
  return {
    status: "active",
    imageUrl: null,
    ...partial,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("auditCatalogPhotos", () => {
  it("classifies ok, missing, invalid-key and not-r2 like the storefront (AC1, E14, E15)", async () => {
    const calls: string[] = [];
    const present = new Set(["catalog/present.webp", "catalog/yam.webp"]);
    const headObject = async (key: string): Promise<HeadResult> => {
      calls.push(key);
      return present.has(key) ? "present" : "missing";
    };
    const { rows, counts } = await auditCatalogPhotos({
      products: [
        product({ id: "p1", name: "Present", status: "rejected", imageUrl: "/api/catalog-image/catalog/present.webp" }),
        product({ id: "m1", name: "Missing", status: "inactive", imageUrl: "/api/catalog-image/catalog/missing.jpg" }),
        product({ id: "d1", name: "Dotted", imageUrl: "/api/catalog-image/catalog/a.b.jpg" }),
        product({ id: "t1", name: "Traversal", imageUrl: "/api/catalog-image/catalog/../x.jpg" }),
        product({ id: "u1", name: "Upper", imageUrl: "catalog/x.JPG" }),
        product({ id: "o1", name: "OldHost", imageUrl: "https://old.example.com/catalog/yam.webp" }),
        product({ id: "c1", name: "Cutout", imageUrl: "/images/products/yam-white-puna.webp" }),
        product({ id: "w1", name: "Wiki", imageUrl: "https://upload.wikimedia.org/wikipedia/commons/a.jpg" }),
        product({ id: "s1", name: "Svg", imageUrl: "catalog/logo.svg" }),
        product({ id: "e1", name: "Empty", imageUrl: "" }),
        product({ id: "n1", name: "None", imageUrl: null }),
      ],
      headObject,
    });

    expect(calls).toEqual(["catalog/present.webp", "catalog/missing.jpg", "catalog/yam.webp"]);
    expect(rows.map((row) => [row.name, row.status, row.key, row.reason, row.productStatus])).toEqual([
      ["Cutout", "not-r2", null, "storefront returns this URL unchanged", "active"],
      ["Dotted", "invalid-key", "catalog/a.b.jpg", "route allowlist refuses this key", "active"],
      ["Missing", "missing", "catalog/missing.jpg", "R2 HeadObject returned 404", "inactive"],
      ["OldHost", "ok", "catalog/yam.webp", "object exists", "active"],
      ["Present", "ok", "catalog/present.webp", "object exists", "rejected"],
      ["Svg", "not-r2", null, "storefront hides this photo", "active"],
      ["Traversal", "invalid-key", "/api/catalog-image/catalog/../x.jpg", "catalog path is not a single object key", "active"],
      ["Upper", "invalid-key", "catalog/x.JPG", "extension is not a lowercase jpg, png, or webp catalog key", "active"],
      ["Wiki", "not-r2", null, "storefront hides this photo", "active"],
    ]);
    expect(counts).toMatchObject({
      ok: 2,
      missing: 1,
      "invalid-key": 3,
      "not-r2": 3,
      "no-image": 2,
      checkedKeys: 3,
    });
    expect(counts.missingExtensions).toEqual({ jpg: 1 });
    expect(counts.ok + counts.missing + counts["invalid-key"] + counts["not-r2"]).toBe(rows.length);
  });

  it("checks an other-host catalog URL the same way with or without R2_PUBLIC_URL (E15)", async () => {
    const head = vi.fn(async (): Promise<HeadResult> => "present");
    const products = [product({ id: "1", name: "Yam", imageUrl: "https://cdn.other.test/catalog/x.webp" })];
    vi.stubEnv("R2_PUBLIC_URL", "");
    const without = await auditCatalogPhotos({ products, headObject: head });
    vi.stubEnv("R2_PUBLIC_URL", "https://media.example.com");
    const withPublic = await auditCatalogPhotos({ products, headObject: head });
    expect(without.rows[0]).toMatchObject({ status: "ok", key: "catalog/x.webp" });
    expect(withPublic.rows).toEqual(without.rows);
    expect(head).toHaveBeenCalledTimes(2);
    expect(head).toHaveBeenNthCalledWith(1, "catalog/x.webp");
  });

  it("recognizes only the local ?retry=1 allowlist (E23)", async () => {
    const calls: string[] = [];
    const { rows } = await auditCatalogPhotos({
      products: [
        product({ id: "1", name: "Retry", imageUrl: "/api/catalog-image/catalog/yam.webp?retry=1" }),
        product({ id: "2", name: "Extra", imageUrl: "/api/catalog-image/catalog/yam.webp?retry=1&x=1" }),
        product({ id: "3", name: "Remote", imageUrl: "https://old.example.com/catalog/yam.webp?x=1" }),
        product({ id: "4", name: "Fragment", imageUrl: "https://old.example.com/catalog/yam.webp#frag" }),
        product({ id: "5", name: "Encoded", imageUrl: "catalog/yam%20white.webp" }),
      ],
      headObject: async (key) => {
        calls.push(key);
        return "present";
      },
    });
    expect(calls).toEqual(["catalog/yam.webp"]);
    expect(rows.find((row) => row.id === "1")).toMatchObject({ status: "ok", key: "catalog/yam.webp" });
    expect(rows.find((row) => row.id === "2")).toMatchObject({
      status: "invalid-key",
      reason: "local catalog URL is not a bare key or the allowlisted ?retry=1 query",
    });
    expect(rows.find((row) => row.id === "3")).toMatchObject({
      status: "not-r2",
      reason: "storefront returns this URL unchanged",
    });
    expect(rows.find((row) => row.id === "4")).toMatchObject({ status: "not-r2" });
    expect(rows.find((row) => row.id === "5")).toMatchObject({
      status: "invalid-key",
      reason: "catalog path is not a servable route key",
    });
  });

  it("skips null, empty and whitespace image URLs without a check (E12, E24)", async () => {
    const head = vi.fn(async (): Promise<HeadResult> => "missing");
    const { rows, counts } = await auditCatalogPhotos({
      products: [
        product({ id: "1", name: "Blank", imageUrl: "   " }),
        product({ id: "2", name: "Tab", imageUrl: "\t" }),
        product({ id: "3", name: "Empty", imageUrl: "" }),
        product({ id: "4", name: "None", imageUrl: null }),
        product({ id: "5", name: "Padded", imageUrl: " catalog/yam.jpg" }),
        product({ id: "6", name: "SvgQuery", imageUrl: "catalog/logo.svg?retry=1" }),
        product({ id: "7", name: "SvgUpper", imageUrl: "catalog/logo.SVG" }),
      ],
      headObject: head,
    });
    expect(head).not.toHaveBeenCalled();
    expect(counts["no-image"]).toBe(4);
    expect(rows.map((row) => [row.id, row.status, row.reason])).toEqual([
      ["5", "not-r2", "storefront returns this URL unchanged"],
      ["6", "invalid-key", "local catalog URL is not a bare key or the allowlisted ?retry=1 query"],
      ["7", "invalid-key", "extension is not a lowercase jpg, png, or webp catalog key"],
    ]);
    expect(rows.find((row) => row.id === "7")?.reason).not.toBe("storefront hides this photo");
  });

  it("checks each distinct key once and reports every row (AC2, E2)", async () => {
    const calls: string[] = [];
    const products = [
      ...Array.from({ length: 15 }, (_, index) => product({
        id: `leaf-${index}`,
        name: `Leaf ${String(index).padStart(2, "0")}`,
        imageUrl: "/api/catalog-image/catalog/storefront-test.jpg",
      })),
      product({ id: "other", name: "Other", imageUrl: "catalog/other.webp" }),
    ];
    const { rows, counts } = await auditCatalogPhotos({
      products,
      headObject: async (key) => {
        calls.push(key);
        return key.endsWith(".jpg") ? "missing" : "present";
      },
    });
    expect(calls).toEqual(["catalog/storefront-test.jpg", "catalog/other.webp"]);
    expect(rows).toHaveLength(16);
    expect(counts.missing).toBe(15);
    expect(counts.ok).toBe(1);
    expect(counts.checkedKeys).toBe(2);
    expect(counts.missingExtensions).toEqual({ jpg: 15 });
  });

  it("keeps at most 8 HEADs in flight over 1,500 products (AC2, E6)", async () => {
    const shared = Array.from({ length: 15 }, (_, index) => product({
      id: `shared-${index}`,
      name: `Shared ${String(index).padStart(4, "0")}`,
      imageUrl: "catalog/storefront-test.jpg",
    }));
    const unique = Array.from({ length: 1485 }, (_, index) => product({
      id: `uniq-${index}`,
      name: `Unique ${String(index).padStart(4, "0")}`,
      imageUrl: `catalog/item-${index}.webp`,
    }));
    let started = 0;
    let inFlight = 0;
    let peak = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = auditCatalogPhotos({
      products: [...shared, ...unique],
      headObject: async () => {
        started += 1;
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await gate;
        inFlight -= 1;
        return "present";
      },
    });
    const deadline = Date.now() + 2000;
    while (started < 8) {
      if (Date.now() > deadline) throw new Error(`only started ${started}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(started).toBe(8);
    expect(peak).toBe(8);
    release();
    const { rows, counts } = await pending;
    expect(rows).toHaveLength(1500);
    expect(counts.checkedKeys).toBe(1486);
    expect(started).toBe(1486);
    expect(peak).toBeLessThanOrEqual(8);
  });

  it("rejects the whole audit when one HEAD fails mid-flight (E4, E7)", async () => {
    const keys = Array.from({ length: 20 }, (_, index) => `catalog/k${String(index).padStart(2, "0")}.webp`);
    const deferred = new Map<string, { resolve: (value: HeadResult) => void; reject: (err: unknown) => void }>();
    let started = 0;
    const pending = auditCatalogPhotos({
      products: keys.map((key, index) => product({ id: `id-${index}`, name: `Name ${index}`, imageUrl: key })),
      headObject: (key) => {
        started += 1;
        return new Promise<HeadResult>((resolve, reject) => {
          deferred.set(key, { resolve, reject });
        });
      },
    });
    const deadline = Date.now() + 2000;
    while (started < 8) {
      if (Date.now() > deadline) throw new Error(`only started ${started}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(started).toBe(8);
    const unhandled: unknown[] = [];
    const onUnhandled = (err: unknown) => { unhandled.push(err); };
    process.on("unhandledRejection", onUnhandled);
    try {
      const firstKey = keys[3]!;
      const laterKey = keys[0]!;
      deferred.get(firstKey)?.reject(Object.assign(new Error("denied"), { name: "Unknown", $metadata: { httpStatusCode: 403 } }));
      await Promise.resolve();
      deferred.get(laterKey)?.reject(Object.assign(new Error("slow"), { name: "SlowDown", $metadata: { httpStatusCode: 503 } }));
      for (const [key, item] of deferred) {
        if (key !== firstKey && key !== laterKey) item.resolve("present");
      }
      await expect(pending).rejects.toThrow(`HeadObject failed for ${firstKey}: HTTP 403`);
      expect(started).toBe(8);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("does not start a new key after an already-settled HeadObject failure (E4, E7)", async () => {
    const keys = Array.from({ length: 20 }, (_, index) => `catalog/k${String(index).padStart(2, "0")}.webp`);
    for (const failing of ["catalog/k03.webp", "catalog/k07.webp"]) {
      const calls: string[] = [];
      await expect(auditCatalogPhotos({
        products: keys.map((key, index) => product({ id: `${failing}-${index}`, name: key, imageUrl: key })),
        headObject: async (key) => {
          calls.push(key);
          if (key === failing) {
            throw Object.assign(new Error("denied"), { name: "Unknown", $metadata: { httpStatusCode: 403 } });
          }
          return "missing";
        },
      })).rejects.toThrow(`HeadObject failed for ${failing}: HTTP 403`);
      expect(calls).toEqual(keys.slice(0, 8));
    }
  });

  it("stops scheduling after failure and consumes late rejections (E29)", async () => {
    const keys = ["catalog/a.webp", "catalog/b.webp", "catalog/c.webp"];
    const deferred = new Map<string, { resolve: (value: HeadResult) => void; reject: (err: unknown) => void }>();
    const pending = auditCatalogPhotos({
      products: keys.map((key, index) => product({ id: String(index), name: key, imageUrl: key })),
      concurrency: 2,
      headObject: (key) => new Promise<HeadResult>((resolve, reject) => {
        deferred.set(key, { resolve, reject });
      }),
    });
    const deadline = Date.now() + 2000;
    while (deferred.size < 2) {
      if (Date.now() > deadline) throw new Error("workers did not start");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect([...deferred.keys()]).toEqual(keys.slice(0, 2));
    deferred.get(keys[0]!)?.reject(Object.assign(new Error("no"), { $metadata: { httpStatusCode: 429 } }));
    deferred.get(keys[1]!)?.resolve("missing");
    await expect(pending).rejects.toThrow("HeadObject failed for catalog/a.webp: HTTP 429");
    expect(deferred.has(keys[2]!)).toBe(false);
  });

  it("validates every concurrency option before scheduling (E29)", async () => {
    const head = vi.fn(async (): Promise<HeadResult> => "present");
    const products = [product({ id: "1", name: "A", imageUrl: "catalog/a.webp" })];
    for (const concurrency of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 9]) {
      await expect(auditCatalogPhotos({ products, headObject: head, concurrency })).rejects.toThrow(
        "concurrency must be an integer from 1 to 8",
      );
    }
    expect(head).not.toHaveBeenCalled();
    const one = await auditCatalogPhotos({ products, headObject: head, concurrency: 1 });
    expect(one.counts.checkedKeys).toBe(1);
  });

  it("sorts by name then id with unicode names and long URLs (E13)", async () => {
    const longUrl = `https://example.com/${"a".repeat(1980)}`;
    expect(longUrl.length).toBeGreaterThanOrEqual(2000);
    const { rows } = await auditCatalogPhotos({
      products: [
        product({ id: "c", name: "yam", imageUrl: longUrl }),
        product({ id: "a", name: "yam", imageUrl: "/images/products/yam.webp" }),
        product({ id: "d", name: "Éba", imageUrl: "/images/products/eba.webp" }),
        product({ id: "b", name: "eba", imageUrl: "catalog/not a key" }),
      ],
      headObject: async () => "present",
    });
    expect(rows.map((row) => [row.name, row.id])).toEqual([
      ["eba", "b"],
      ["yam", "a"],
      ["yam", "c"],
      ["Éba", "d"],
    ]);
    expect(rows.find((row) => row.id === "b")?.status).toBe("invalid-key");
    expect(rows.find((row) => row.id === "c")?.status).toBe("not-r2");
  });

  it("empty product list returns zero counts without calling headObject (E11)", async () => {
    const head = vi.fn(async (): Promise<HeadResult> => "missing");
    const { rows, counts } = await auditCatalogPhotos({ products: [], headObject: head });
    expect(head).not.toHaveBeenCalled();
    expect(rows).toEqual([]);
    expect(counts).toEqual({
      ok: 0,
      missing: 0,
      "invalid-key": 0,
      "not-r2": 0,
      "no-image": 0,
      checkedKeys: 0,
      missingExtensions: {},
    });
  });

  it("reports per-row missing extensions and per-key check totals (E32)", async () => {
    const products = [
      ...Array.from({ length: 15 }, (_, index) => product({
        id: `jpg-${index}`,
        name: `Jpg ${index}`,
        imageUrl: "catalog/storefront-test.jpg",
      })),
      product({ id: "webp", name: "Webp", imageUrl: "catalog/pepper.webp" }),
      product({ id: "png", name: "Png", imageUrl: "catalog/ok.png" }),
    ];
    const { counts, rows } = await auditCatalogPhotos({
      products,
      headObject: async (key) => (key.endsWith(".png") ? "present" : "missing"),
    });
    expect(rows).toHaveLength(17);
    expect(counts.missing).toBe(16);
    expect(counts.ok).toBe(1);
    expect(counts.checkedKeys).toBe(3);
    expect(counts.missingExtensions).toEqual({ jpg: 15, webp: 1 });
    const extensionTotal = Object.values(counts.missingExtensions).reduce((sum, count) => sum + count, 0);
    expect(extensionTotal).toBe(counts.missing);
  });

  it("returns the same rows when run twice on the same input (E3)", async () => {
    const products = [
      product({ id: "2", name: "B", imageUrl: "catalog/b.webp" }),
      product({ id: "1", name: "A", imageUrl: null }),
    ];
    const head = async (): Promise<HeadResult> => "missing";
    const first = await auditCatalogPhotos({ products, headObject: head });
    const second = await auditCatalogPhotos({ products, headObject: head });
    expect(second).toEqual(first);
  });

  it("orders rows by name even when HEADs finish out of order (E33)", async () => {
    const finished: string[] = [];
    const { rows } = await auditCatalogPhotos({
      products: [
        product({ id: "1", name: "Zed", imageUrl: "catalog/z.webp" }),
        product({ id: "2", name: "Amy", imageUrl: "catalog/a.webp" }),
      ],
      concurrency: 2,
      headObject: async (key) => {
        await new Promise((resolve) => setTimeout(resolve, key.endsWith("z.webp") ? 1 : 20));
        finished.push(key);
        return "present";
      },
    });
    expect(finished[0]).toBe("catalog/z.webp");
    expect(rows.map((row) => row.name)).toEqual(["Amy", "Zed"]);
  });

  it("has no money fields in the report (E20)", async () => {
    const { rows } = await auditCatalogPhotos({
      products: [product({ id: "1", name: "Yam", imageUrl: "/images/products/yam.webp" })],
      headObject: async () => "present",
    });
    expect(Object.keys(rows[0]!).sort()).toEqual(["ext", "id", "key", "name", "productStatus", "reason", "status"]);
  });
});
