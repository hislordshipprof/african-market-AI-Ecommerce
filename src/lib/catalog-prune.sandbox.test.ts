import { S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import { planCatalogPrune } from "./catalog-prune";
import { deleteCatalogCandidates, listCatalogObjects } from "./catalog-prune-execute";
import { createFakeR2 } from "./catalog-prune-fake-r2";
import { cleanupSandboxManifest, pruneSandboxManifest, sandboxRunPrefix } from "./catalog-prune-sandbox";
import { liveSandbox } from "./test-live-provider";

const sandboxBucket = process.env.R2_SANDBOX_BUCKET;
const sandboxAccess = process.env.R2_SANDBOX_ACCESS_KEY_ID;
const sandboxSecret = process.env.R2_SANDBOX_SECRET_ACCESS_KEY;
const hasSandbox = Boolean(sandboxBucket && sandboxAccess && sandboxSecret && process.env.R2_ACCOUNT_ID);

describe("catalog prune sandbox", () => {
  it("production executor deletes only the old unreferenced object and a later list matches the provider", async () => {
    const bucket = "t225-sandbox-fake";
    const prefix = "catalog/prune-sandbox/run/";
    const orphan = `${prefix}orphan.jpg`;
    const keep = `${prefix}keep.jpg`;
    const unrelated = `${prefix}unrelated.jpg`;
    const now = new Date("2026-06-15T12:00:00.000Z");
    const old = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const fresh = new Date(now.getTime() - 60 * 60 * 1000);
    const fake = createFakeR2({
      bucket,
      objects: [
        { key: orphan, lastModified: old },
        { key: keep, lastModified: old },
        { key: unrelated, lastModified: fresh },
      ],
    });
    const listed = await listCatalogObjects(fake, bucket, prefix);
    const candidates = planCatalogPrune({
      objects: listed,
      references: [keep],
      now,
    });
    expect(candidates).toEqual([orphan]);
    const logs: string[] = [];
    await deleteCatalogCandidates({ client: fake, bucket, keys: candidates, log: (line) => logs.push(line) });
    expect(logs).toContain(`deleted ${orphan}`);
    const after = await listCatalogObjects(fake, bucket, prefix);
    expect(after.map((object) => object.key).sort()).toEqual([keep, unrelated].sort());
  });

  it("a failed delete cleans only keys this run created", async () => {
    const bucket = "t225-sandbox-fake";
    const prefix = "catalog/prune-sandbox/fail/";
    const orphan = `${prefix}orphan.jpg`;
    const keep = `${prefix}keep.jpg`;
    const foreign = `${prefix}foreign.jpg`;
    const now = new Date("2026-06-15T12:00:00.000Z");
    const old = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const fake = createFakeR2({
      bucket,
      objects: [
        { key: orphan, lastModified: old },
        { key: keep, lastModified: old },
        { key: foreign, lastModified: old },
      ],
    });
    let deny = true;
    const client = {
      async send(command: unknown) {
        const input = (command as { input?: { Delete?: { Objects?: { Key?: string }[] } } }).input;
        if (deny && input?.Delete) {
          deny = false;
          return {
            Deleted: [],
            Errors: [{ Key: orphan, Code: "AccessDenied" }],
            $metadata: { httpStatusCode: 200 },
          };
        }
        return fake.send(command);
      },
    };
    const created = [orphan, keep];
    await expect(pruneSandboxManifest({
      client,
      bucket,
      prefix,
      created,
      references: [keep],
      now,
    })).rejects.toThrow(/AccessDenied/);
    expect((await listCatalogObjects(fake, bucket, prefix)).map((object) => object.key).sort()).toEqual([foreign, keep, orphan].sort());
    await cleanupSandboxManifest({ client, bucket, prefix, created });
    expect((await listCatalogObjects(fake, bucket, prefix)).map((object) => object.key)).toEqual([foreign]);
  });

  it("real R2 scratch bucket: dry-run lists and bucket-name prune deletes only the unreferenced old object", async (ctx) => {
    if (!liveSandbox) {
      ctx.skip("LIVE_SANDBOX=1 is not set.");
      return;
    }
    if (!hasSandbox) {
      ctx.skip("R2_SANDBOX_BUCKET, R2_SANDBOX_ACCESS_KEY_ID and R2_SANDBOX_SECRET_ACCESS_KEY are not set. This does not block the build.");
      return;
    }
    if (sandboxBucket === process.env.R2_BUCKET || sandboxBucket === "african-markets-dev") {
      throw new Error("Refusing sandbox prune: scratch bucket matches the shared bucket");
    }
    const prefix = sandboxRunPrefix();
    const orphan = `${prefix}orphan.jpg`;
    const keep = `${prefix}keep.jpg`;
    const unrelated = `${prefix}unrelated.jpg`;
    const client = new S3Client({
      region: "auto",
      endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: sandboxAccess!, secretAccessKey: sandboxSecret! },
    });
    const { PutObjectCommand } = await import("@aws-sdk/client-s3");
    const manifest = [orphan, keep, unrelated];
    const created: string[] = [];
    let cleanupError: unknown;
    try {
      for (const key of manifest) {
        await client.send(new PutObjectCommand({
          Bucket: sandboxBucket,
          Key: key,
          Body: Buffer.from("t225"),
          ContentType: "image/jpeg",
        }));
        created.push(key);
      }
      const now = new Date(Date.now() + 25 * 60 * 60 * 1000);
      const candidates = await pruneSandboxManifest({
        client,
        bucket: sandboxBucket!,
        prefix,
        created,
        references: [keep, unrelated],
        now,
      });
      expect(candidates).toEqual([orphan]);
      const after = await listCatalogObjects(client, sandboxBucket!, prefix);
      expect(after.map((object) => object.key).sort()).toEqual([keep, unrelated].sort());
    } finally {
      try {
        await cleanupSandboxManifest({
          client,
          bucket: sandboxBucket!,
          prefix,
          created,
        });
      } catch (error) {
        cleanupError = error;
      }
    }
    if (cleanupError) throw cleanupError;
  });

  it("sandbox execution and cleanup are restricted to this run manifest", async () => {
    const bucket = "t225-sandbox-fake";
    const prefix = sandboxRunPrefix();
    const orphan = `${prefix}orphan.jpg`;
    const keep = `${prefix}keep.jpg`;
    const unrelated = `${prefix}unrelated.jpg`;
    const foreign = `${prefix}foreign.jpg`;
    const now = new Date("2026-06-15T12:00:00.000Z");
    const old = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const created = [orphan, keep, unrelated];
    const fake = createFakeR2({
      bucket,
      objects: [orphan, keep, unrelated, foreign].map((key) => ({ key, lastModified: old })),
    });
    const candidates = await pruneSandboxManifest({
      client: fake,
      bucket,
      prefix,
      created,
      references: [keep, unrelated],
      now,
    });
    expect(candidates).toEqual([orphan]);
    expect(fake.objects().map((object) => object.key)).toContain(foreign);
    await cleanupSandboxManifest({ client: fake, bucket, prefix, created });
    expect(fake.objects().map((object) => object.key)).toEqual([foreign]);
    expect(sandboxBucket === "african-markets-dev").toBe(false);
  });

  it("a halfway upload failure cleans only keys this run created", async () => {
    const bucket = "t225-sandbox-fake";
    const prefix = sandboxRunPrefix();
    const orphan = `${prefix}orphan.jpg`;
    const keep = `${prefix}keep.jpg`;
    const foreign = `${prefix}foreign.jpg`;
    const old = new Date("2020-01-01T00:00:00.000Z");
    const fake = createFakeR2({
      bucket,
      objects: [orphan, keep, foreign].map((key) => ({ key, lastModified: old })),
    });
    const created = [orphan];
    await cleanupSandboxManifest({ client: fake, bucket, prefix, created });
    expect(fake.objects().map((object) => object.key).sort()).toEqual([foreign, keep].sort());
  });
});
