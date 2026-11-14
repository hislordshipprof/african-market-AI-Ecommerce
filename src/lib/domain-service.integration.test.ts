import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({
  unstable_cache: (fn: () => unknown) => () => fn(),
  revalidateTag: () => {},
}));

import { platformAdmin } from "./db";
import { findStoreByDomain } from "./get-store";
import { addDomainToStore, getDomainStatus, removeDomainFromStore } from "./domain-service";
import {
  FakeVercelDomainsAdapter,
  resetVercelDomainsAdapter,
  setVercelDomainsAdapter,
} from "./vercel-domains";

const suffix = `${Date.now()}-dom`;
const domainA = `shop-a-${suffix}.integ.example`;
const domainB = `shop-b-${suffix}.integ.example`;
const missingStoreId = "00000000-0000-0000-0000-000000000000";

describe("custom domains against the real DB", () => {
  let storeA: string;
  let storeB: string;
  let vercel: FakeVercelDomainsAdapter;

  beforeAll(async () => {
    storeA = (await platformAdmin.store.create({ data: { name: "Domain A", slug: `dom-a-${suffix}` } })).id;
    storeB = (await platformAdmin.store.create({ data: { name: "Domain B", slug: `dom-b-${suffix}` } })).id;
  });

  afterAll(async () => {
    await platformAdmin.store.deleteMany({ where: { id: { in: [storeA, storeB] } } });
    resetVercelDomainsAdapter();
  });

  beforeEach(async () => {
    await platformAdmin.store.updateMany({
      where: { id: { in: [storeA, storeB] } },
      data: { customDomain: null },
    });
    vercel = new FakeVercelDomainsAdapter();
    setVercelDomainsAdapter(vercel);
  });

  it("each store's domain resolves to that store, and an unregistered domain to null", async () => {
    expect(await addDomainToStore(storeA, domainA)).toEqual({
      ok: true,
      domain: domainA,
      verified: false,
      cname: "cname.vercel-dns.com",
    });
    expect((await addDomainToStore(storeB, domainB)).ok).toBe(true);

    expect((await findStoreByDomain(domainA))?.id).toBe(storeA);
    expect((await findStoreByDomain(domainB))?.id).toBe(storeB);
    expect(await findStoreByDomain(`unregistered-${suffix}.integ.example`)).toBeNull();
  });

  it("GET reports the saved domain and its verification status", async () => {
    await addDomainToStore(storeA, domainA);
    expect(await getDomainStatus(storeA)).toMatchObject({ ok: true, domain: domainA, verified: false });
    vercel.setVerified(domainA, true);
    expect(await getDomainStatus(storeA)).toMatchObject({ ok: true, verified: true });
  });

  it("a domain another store holds is refused with 409 and the store keeps no domain", async () => {
    await addDomainToStore(storeA, domainA);
    expect(await addDomainToStore(storeB, domainA)).toMatchObject({ ok: false, status: 409 });
    expect((await platformAdmin.store.findUnique({ where: { id: storeB } }))?.customDomain).toBeNull();
  });

  it("the unique index turns a lost race into 409, not a 500", async () => {
    // Store A claims the domain between B's pre-check and B's write.
    setVercelDomainsAdapter({
      addDomain: async (domain: string) => {
        await platformAdmin.store.update({ where: { id: storeA }, data: { customDomain: domain } });
        return { domain, verified: false, cname: "cname.vercel-dns.com" };
      },
      getDomainConfig: (d: string) => vercel.getDomainConfig(d),
      removeDomain: (d: string) => vercel.removeDomain(d),
    });
    expect(await addDomainToStore(storeB, domainA)).toMatchObject({ ok: false, status: 409 });
    expect((await findStoreByDomain(domainA))?.id).toBe(storeA);
  });

  it("DELETE clears the domain so it no longer resolves, and frees it for another store", async () => {
    await addDomainToStore(storeA, domainA);
    expect(await removeDomainFromStore(storeA)).toMatchObject({ ok: true, domain: domainA });
    expect(await findStoreByDomain(domainA)).toBeNull();
    await expect(vercel.getDomainConfig(domainA)).rejects.toMatchObject({ status: 404 });
    expect((await addDomainToStore(storeB, domainA)).ok).toBe(true);
  });

  it("a nonexistent store is 404 for POST, GET and DELETE", async () => {
    expect(await addDomainToStore(missingStoreId, domainA)).toMatchObject({ ok: false, status: 404 });
    expect(await getDomainStatus(missingStoreId)).toMatchObject({ ok: false, status: 404 });
    expect(await removeDomainFromStore(missingStoreId)).toMatchObject({ ok: false, status: 404 });
  });
});
