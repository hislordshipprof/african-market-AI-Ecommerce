import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.AUTH_RATE_LIMIT_RELAXED = "1";
});

const { headerState, fakeState, bucket } = vi.hoisted(() => ({
  headerState: new Headers(),
  fakeState: { fetch: (async () => new Response("unscripted", { status: 500 })) as typeof fetch },
  bucket: new Map<string, { bucket: string; body: Uint8Array; contentType?: string }>(),
}));

vi.mock("next/headers", () => ({ headers: async () => headerState }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("next/cache", () => ({
  unstable_cache: (fn: () => unknown) => () => fn(),
  revalidateTag: () => {},
  revalidatePath: () => {},
}));
vi.mock("../assistant/model", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../assistant/model")>();
  return { ...actual, createAssistantModel: () => actual.createAssistantModel({ fetch: fakeState.fetch }) };
});
// R2 keys are not in this lane's .env.local: the S3 client is a recording fake that keeps each bucket's objects.
vi.mock("@aws-sdk/client-s3", () => {
  class PutObjectCommand {
    constructor(readonly input: { Bucket: string; Key: string; Body: Uint8Array; ContentType?: string }) {}
  }
  class GetObjectCommand {
    constructor(readonly input: { Bucket: string; Key: string }) {}
  }
  class DeleteObjectCommand {
    constructor(readonly input: { Bucket: string; Key: string }) {}
  }
  class S3Client {
    async send(command: PutObjectCommand | GetObjectCommand | DeleteObjectCommand) {
      if (command instanceof PutObjectCommand) {
        bucket.set(command.input.Key, { bucket: command.input.Bucket, body: command.input.Body, contentType: command.input.ContentType });
        return {};
      }
      if (command instanceof DeleteObjectCommand) {
        bucket.delete(command.input.Key);
        return {};
      }
      const object = bucket.get(command.input.Key);
      if (!object || object.bucket !== command.input.Bucket) throw new Error("NoSuchKey");
      return {
        ContentType: object.contentType,
        Body: {
          transformToByteArray: async () => new Uint8Array(object.body),
          transformToWebStream: () => new Blob([new Uint8Array(object.body)]).stream(),
        },
      };
    }
  }
  return { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand };
});

import sharp from "sharp";
import { generateTOTP } from "../../../e2e/totp";
import { createFakeAnthropicFetch } from "../assistant/messages-api-double";
import { setSpendClock } from "../assistant/spend";
import { authPrisma, storeScoped } from "../db";
import { isServableCatalogKey } from "../r2";
import { publishListingDrafts, uploadShelfPhoto } from "../listing/photo-draft-actions";
import { searchListings } from "../storefront/service";
import { approveProductProposal, listProductProposals, rejectProductProposal } from "../admin/product-proposals";
import { listStoreProposals } from "./product-proposals";
import { authPost, testSignUp } from "../test-auth";
import { GET as getShelfPhoto } from "../../app/api/listing-photo/[draftId]/route";
import { GET as getProposalPhoto } from "../../app/api/admin/product-proposals/[id]/photo/route";

const RUN = `t553-${Date.now()}`;
const TAG = `zp${Date.now().toString(36)}`;
const password = "Product-Proposals-553!";
const hasDb = !!process.env.DATABASE_URL;

function cookiesOf(response: Response, jar: Map<string, string>): string {
  for (const raw of response.headers.getSetCookie?.() ?? []) {
    const pair = raw.split(";")[0]!.trim();
    const eq = pair.indexOf("=");
    if (eq > 0) jar.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

async function signIn(email: string): Promise<string> {
  const jar = new Map<string, string>();
  const signedIn = await authPost("/sign-in/email", { email, password });
  expect(signedIn.status, await signedIn.clone().text()).toBe(200);
  let cookies = cookiesOf(signedIn, jar);
  const enabled = await authPost("/two-factor/enable", { password }, cookies);
  cookies = cookiesOf(enabled, jar);
  const secret = new URL(((await enabled.json()) as { totpURI: string }).totpURI).searchParams.get("secret")!;
  const verified = await authPost("/two-factor/verify-totp", { code: generateTOTP(secret) }, cookies);
  expect(verified.status, await verified.clone().text()).toBe(200);
  return cookiesOf(verified, jar);
}

function as(cookies: string, slug?: string): void {
  headerState.set("cookie", cookies);
  if (slug) headerState.set("x-store-slug", slug);
  else headerState.delete("x-store-slug");
}

/** A 200 x 100 shelf photo; the model reads the given unmatched items from it. */
async function shelfOf(names: string[]): Promise<FormData> {
  const fake = createFakeAnthropicFetch({
    expectedKey: "sk-ant-test",
    steps: [{ kind: "tool", toolName: "shelf_items", toolInput: { items: names.map((name) => ({ name, size: "500g", price: null })) } }],
  });
  fakeState.fetch = fake.fetch;
  const jpeg = await sharp({ create: { width: 200, height: 100, channels: 3, background: { r: 200, g: 120, b: 40 } } }).jpeg().toBuffer();
  const form = new FormData();
  form.set("photo", new File([new Uint8Array(jpeg)], "shelf.jpg", { type: "image/jpeg" }));
  return form;
}

describe.skipIf(!hasDb)("product proposals from unmatched shelf items (real auth, lane database)", () => {
  const storeAId = crypto.randomUUID();
  const storeBId = crypto.randomUUID();
  const slugA = `ppa-${RUN}`;
  const slugB = `ppb-${RUN}`;
  const emails = { owner: `owner-${RUN}@example.com`, outsider: `outsider-${RUN}@example.com`, admin: `admin-${RUN}@example.com` };
  const cookies = { owner: "", outsider: "", admin: "" };
  const ids = { category: "", existing: "", listedByA: "", ownerId: "", outsiderId: "" };
  const drafts: Record<string, string> = {};

  beforeAll(async () => {
    setSpendClock(() => new Date("2099-11-15T12:00:00.000Z"));
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    vi.stubEnv("ASSISTANT_MODEL", "");
    vi.stubEnv("ASSISTANT_SPEND_CAP_USD", "1000000");
    vi.stubEnv("R2_PROOF_BUCKET", "proof-test");
    vi.stubEnv("R2_BUCKET", "catalog-test");
    vi.stubEnv("R2_PUBLIC_URL", "");
    vi.stubEnv("R2_ACCOUNT_ID", "test");
    vi.stubEnv("R2_ACCESS_KEY_ID", "test");
    vi.stubEnv("R2_SECRET_ACCESS_KEY", "test");

    for (const email of Object.values(emails)) {
      const res = await testSignUp({ email, password, name: email.split("@")[0] });
      expect(res.status, await res.clone().text()).toBe(200);
    }
    const userId = async (email: string) => (await authPrisma.user.findFirstOrThrow({ where: { email } })).id;
    ids.ownerId = await userId(emails.owner);
    ids.outsiderId = await userId(emails.outsider);
    await authPrisma.user.update({ where: { email: emails.admin }, data: { role: "platform_admin" } });

    await authPrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await tx.$executeRaw`INSERT INTO stores (id, name, slug, status, updated_at) VALUES (${storeAId}, ${"Proposals A " + RUN}, ${slugA}, 'active', now())`;
      await tx.$executeRaw`INSERT INTO stores (id, name, slug, status, updated_at) VALUES (${storeBId}, ${"Proposals B " + RUN}, ${slugB}, 'active', now())`;
      for (const [store, user] of [[storeAId, ids.ownerId], [storeBId, ids.outsiderId]] as const) {
        await tx.$executeRaw`INSERT INTO store_memberships (id, store_id, user_id, role, updated_at) VALUES (${crypto.randomUUID()}, ${store}, ${user}, 'owner', now())`;
      }
      ids.category = (await tx.category.create({ data: { name: `Soups ${TAG}`, slug: `soups-${TAG}`, sortOrder: 950 } })).id;
      ids.existing = (await tx.masterProduct.create({ data: { name: `Dried Okra ${TAG} Existing`, status: "active" } })).id;
      ids.listedByA = (await tx.masterProduct.create({ data: { name: `Crayfish ${TAG} Listed`, status: "active" } })).id;
      await tx.$executeRaw`SELECT set_config('app.store_id', ${storeAId}, true)`;
      await tx.listing.create({ data: { storeId: storeAId, masterProductId: ids.listedByA, price: 700, stockMode: "status", status: "in_stock" } });
    });

    cookies.owner = await signIn(emails.owner);
    cookies.outsider = await signIn(emails.outsider);
    cookies.admin = await signIn(emails.admin);

    // Three items the catalog does not know, read from one shelf photo.
    as(cookies.owner, slugA);
    const names = [`Ogiri Okpei ${TAG}`, `Uziza Seeds ${TAG}`, `Ehuru Pods ${TAG}`];
    expect(await uploadShelfPhoto(await shelfOf(names))).toMatchObject({ ok: true, created: 3 });
    for (const draft of await storeScoped(storeAId).listingDraft.findMany({ where: { status: "pending" } })) {
      expect(draft.match).toBe("none");
      drafts[draft.extractedName.split(" ")[0]!] = draft.id;
    }
  }, 120_000);

  afterAll(() => {
    setSpendClock(null);
    vi.unstubAllEnvs();
  });

  beforeEach(() => as(cookies.owner, slugA));

  const proposalOf = (draftId: string) => storeScoped(storeAId).productProposal.findUniqueOrThrow({ where: { draftId } });

  it("AC1-AC2: an unmatched item publishes as a custom listing at once and goes to the queue with its cropped photo", async () => {
    const published = await publishListingDrafts({
      picks: [
        {
          draftId: drafts.Ogiri!,
          priceCents: 450,
          priceConfirmed: true,
          proposal: {
            name: `Ogiri Okpei ${TAG}`,
            localName: "Ogiri Igbo",
            size: "500g",
            categoryId: ids.category,
            crop: { x: 0.5, y: 0, width: 0.5, height: 0.5 },
          },
        },
        { draftId: drafts.Uziza!, priceCents: 300, priceConfirmed: true, proposal: { name: `Uziza Seeds ${TAG}`, size: "500g" } },
        { draftId: drafts.Ehuru!, priceCents: 250, priceConfirmed: true, proposal: { name: `Ehuru Pods ${TAG}` } },
      ],
    });
    expect(published).toMatchObject({ ok: true, result: { refused: [], proposed: 3 } });

    const proposal = await proposalOf(drafts.Ogiri!);
    expect(proposal).toMatchObject({ storeId: storeAId, status: "pending", name: `Ogiri Okpei ${TAG}`, localName: "Ogiri Igbo", size: "500g", categoryId: ids.category, proposedById: ids.ownerId });
    const listing = await storeScoped(storeAId).listing.findUniqueOrThrow({ where: { id: proposal.listingId } });
    expect([listing.masterProductId, listing.customName, listing.price, listing.active]).toEqual([null, `Ogiri Okpei ${TAG} 500g`, 450, true]);
    expect((await searchListings(storeAId, `Ogiri Okpei ${TAG}`)).map((row) => row.id)).toContain(listing.id);

    // The crop is the shelf photo's top-right quarter, kept privately until an admin approves it.
    expect(proposal.photoKey!.startsWith(`product-proposals/${storeAId}/`)).toBe(true);
    expect(isServableCatalogKey(proposal.photoKey!)).toBe(false);
    const stored = bucket.get(proposal.photoKey!)!;
    expect(stored.bucket).toBe("proof-test");
    expect(await sharp(Buffer.from(stored.body)).metadata()).toMatchObject({ format: "jpeg", width: 100, height: 50 });

    as(cookies.admin);
    const queue = await listProductProposals();
    const row = queue.find((entry) => entry.id === proposal.id)!;
    expect(row).toMatchObject({ storeName: `Proposals A ${RUN}`, name: `Ogiri Okpei ${TAG}`, localName: "Ogiri Igbo", size: "500g", categoryId: ids.category, hasPhoto: true, listingPriceCents: 450 });

    as(cookies.owner, slugA);
    await expect(listProductProposals()).rejects.toThrow(/NEXT_REDIRECT/);
  });

  it("AC3: approving as a new product creates it with the photo as WebP under catalog/ and re-points the listing, audited", async () => {
    const proposal = await proposalOf(drafts.Ogiri!);
    as(cookies.owner, slugA);
    await expect(approveProductProposal({ proposalId: proposal.id, mode: "create", name: "x", usePhoto: false })).rejects.toThrow(/NEXT_REDIRECT/);

    as(cookies.admin);
    const approved = await approveProductProposal({
      proposalId: proposal.id,
      mode: "create",
      name: `Ogiri Okpei ${TAG}`,
      localName: "Ogiri Igbo",
      size: "500g",
      categoryId: ids.category,
      usePhoto: true,
    });
    expect(approved).toEqual({ success: true });

    const after = await proposalOf(drafts.Ogiri!);
    expect(after.status).toBe("approved");
    const product = await authPrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      return tx.masterProduct.findUniqueOrThrow({ where: { id: after.masterProductId! }, include: { synonyms: true } });
    });
    expect(product).toMatchObject({ name: `Ogiri Okpei ${TAG}`, unit: "500g", categoryId: ids.category, status: "active" });
    expect(product.synonyms.map((synonym) => synonym.term)).toEqual(["Ogiri Igbo"]);
    const imageKey = product.imageUrl!.replace(/^.*?(catalog\/)/, "$1");
    expect(isServableCatalogKey(imageKey) && imageKey.endsWith(".webp")).toBe(true);
    expect([bucket.get(imageKey)!.bucket, (await sharp(Buffer.from(bucket.get(imageKey)!.body)).metadata()).format]).toEqual(["catalog-test", "webp"]);

    const listing = await storeScoped(storeAId).listing.findUniqueOrThrow({ where: { id: after.listingId } });
    expect([listing.masterProductId, listing.customName, listing.price]).toEqual([product.id, null, 450]);
    const audits = await storeScoped(storeAId).auditLog.findMany({ where: { entityId: { in: [proposal.id, listing.id] }, action: { startsWith: "catalog." } } });
    expect(audits.map((row) => row.action).sort()).toEqual(["catalog.proposal_approve"]);
    expect(await storeScoped(storeAId).auditLog.findFirst({ where: { action: "listing.catalog_link", entityId: listing.id } })).toMatchObject({
      before: { masterProductId: null, customName: `Ogiri Okpei ${TAG} 500g` },
      after: { masterProductId: product.id, customName: null, proposalId: proposal.id },
    });

    // A second approve (a stale tab) creates nothing.
    expect(await approveProductProposal({ proposalId: proposal.id, mode: "create", name: "Again", usePhoto: false })).toEqual({ error: "This suggestion was already reviewed." });
    expect(await storeScoped(storeAId).auditLog.count({ where: { action: "catalog.proposal_approve", entityId: proposal.id } })).toBe(1);
  });

  it("AC3: approving links to an existing product the admin picks, never to one the store already lists", async () => {
    const proposal = await proposalOf(drafts.Uziza!);
    as(cookies.admin);
    expect(await approveProductProposal({ proposalId: proposal.id, mode: "link", masterProductId: ids.listedByA })).toEqual({
      error: "This store already lists that product. Pick another or create a new one.",
    });
    expect((await proposalOf(drafts.Uziza!)).status).toBe("pending");

    expect(await approveProductProposal({ proposalId: proposal.id, mode: "link", masterProductId: ids.existing })).toEqual({ success: true });
    const after = await proposalOf(drafts.Uziza!);
    expect([after.status, after.masterProductId]).toEqual(["approved", ids.existing]);
    const listing = await storeScoped(storeAId).listing.findUniqueOrThrow({ where: { id: after.listingId } });
    expect([listing.masterProductId, listing.customName, listing.price]).toEqual([ids.existing, null, 300]);
    expect(await storeScoped(storeAId).auditLog.count({ where: { action: "listing.catalog_link", entityId: listing.id } })).toBe(1);
  });

  it("AC4: rejecting leaves the custom listing as it is, audited", async () => {
    const proposal = await proposalOf(drafts.Ehuru!);
    const before = await storeScoped(storeAId).listing.findUniqueOrThrow({ where: { id: proposal.listingId } });
    as(cookies.admin);
    expect(await rejectProductProposal({ proposalId: proposal.id, reason: "Same as Ehuru seeds" })).toEqual({ success: true });
    expect(await proposalOf(drafts.Ehuru!)).toMatchObject({ status: "rejected", rejectReason: "Same as Ehuru seeds", masterProductId: null });
    expect(await storeScoped(storeAId).listing.findUniqueOrThrow({ where: { id: proposal.listingId } })).toEqual(before);
    expect(await storeScoped(storeAId).auditLog.findFirst({ where: { action: "catalog.proposal_reject", entityId: proposal.id } })).toMatchObject({
      storeId: storeAId,
      after: { status: "rejected", reason: "Same as Ehuru seeds" },
    });
    expect(await rejectProductProposal({ proposalId: proposal.id, reason: "" })).toEqual({ error: "This suggestion was already reviewed." });

    as(cookies.owner, slugA);
    const mine = await listStoreProposals(storeAId);
    expect(Object.fromEntries(mine.map((row) => [row.name, row.status]))).toMatchObject({
      [`Ogiri Okpei ${TAG}`]: "approved",
      [`Uziza Seeds ${TAG}`]: "approved",
      [`Ehuru Pods ${TAG}`]: "rejected",
    });
  });

  it("AC5: store B's members never see, create or review store A's proposals", async () => {
    const proposal = await proposalOf(drafts.Ogiri!);
    expect(await listStoreProposals(storeBId)).toEqual([]);
    expect(await storeScoped(storeBId).productProposal.findUnique({ where: { id: proposal.id } })).toBeNull();
    expect(await storeScoped(storeBId).productProposal.count()).toBe(0);
    await expect(storeScoped(storeBId).productProposal.create({
      data: { storeId: storeBId, listingId: proposal.listingId, proposedById: ids.outsiderId, name: "Stolen" },
    })).rejects.toThrow();
    await expect(storeScoped(storeBId).productProposal.create({
      data: { storeId: storeAId, listingId: proposal.listingId, proposedById: ids.outsiderId, name: "Stolen" },
    })).rejects.toThrow();
    // Store members only create; a review is the platform's.
    expect((await storeScoped(storeAId).productProposal.updateMany({ where: { id: proposal.id }, data: { name: "Renamed" } })).count).toBe(0);

    as(cookies.outsider, slugB);
    await expect(rejectProductProposal({ proposalId: proposal.id, reason: "" })).rejects.toThrow(/NEXT_REDIRECT/);

    // The shelf photo the owner crops from is served only to its own store's members.
    const shelfPhoto = (draftId: string) => getShelfPhoto(new Request("http://localhost/"), { params: Promise.resolve({ draftId }) });
    expect((await shelfPhoto(drafts.Ehuru!)).status).toBe(404);
    as(cookies.owner, slugA);
    const own = await shelfPhoto(drafts.Ehuru!);
    expect([own.status, own.headers.get("cache-control")]).toEqual([200, "private, no-store"]);

    // The proposal's crop is served only to platform admins.
    const cropPhoto = () => getProposalPhoto(new Request("http://localhost/"), { params: Promise.resolve({ id: proposal.id }) });
    expect((await cropPhoto()).status).toBe(401);
    as(cookies.admin);
    expect((await cropPhoto()).status).toBe(200);
  });
});
