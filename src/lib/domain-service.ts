import { Prisma } from "@prisma/client";
import { platformAdmin } from "./db";
import { getVercelDomainsAdapter, VercelApiError, type VercelDomainsAdapter } from "./vercel-domains";
import { revalidateStore } from "./get-store";

export type DomainResult =
  | { ok: true; domain: string; verified: boolean; cname: string }
  | { ok: false; error: string; status: number };

// A deployment without Vercel keys answers 503 with the missing key instead of a bare 500.
function vercelAdapter(): VercelDomainsAdapter | { ok: false; error: string; status: number } {
  try {
    return getVercelDomainsAdapter();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Vercel is not configured", status: 503 };
  }
}

export async function addDomainToStore(
  storeId: string,
  domain: string,
): Promise<DomainResult> {
  const store = await platformAdmin.store.findUnique({
    where: { id: storeId },
  });
  if (!store) {
    return { ok: false, error: "Store not found", status: 404 };
  }
  // Swapping in place would orphan the old domain on the Vercel project.
  if (store.customDomain && store.customDomain !== domain) {
    return { ok: false, error: "Store already has a custom domain; remove it first", status: 409 };
  }

  const existing = await platformAdmin.store.findUnique({
    where: { customDomain: domain },
  });
  if (existing && existing.id !== storeId) {
    return {
      ok: false,
      error: "Domain is already assigned to another store",
      status: 409,
    };
  }

  const adapter = vercelAdapter();
  if ("ok" in adapter) return adapter;
  try {
    const result = await adapter.addDomain(domain);

    try {
      await platformAdmin.store.update({
        where: { id: storeId },
        data: { customDomain: domain },
      });
    } catch (dbErr) {
      if (
        dbErr instanceof Prisma.PrismaClientKnownRequestError &&
        dbErr.code === "P2002"
      ) {
        return { ok: false, error: "Domain is already assigned to another store", status: 409 };
      }
      // Left on the project, the domain would block every retry with "already exists".
      await adapter.removeDomain(domain).catch(() => {});
      throw dbErr;
    }

    revalidateStore({ id: storeId, slug: store.slug, customDomain: domain });

    return { ok: true, domain: result.domain, verified: result.verified, cname: result.cname };
  } catch (e) {
    if (e instanceof VercelApiError) {
      return { ok: false, error: e.message, status: e.status };
    }
    throw e;
  }
}

export async function getDomainStatus(
  storeId: string,
): Promise<DomainResult> {
  const store = await platformAdmin.store.findUnique({
    where: { id: storeId },
  });
  if (!store) {
    return { ok: false, error: "Store not found", status: 404 };
  }
  if (!store.customDomain) {
    return { ok: false, error: "Store has no custom domain", status: 404 };
  }

  const adapter = vercelAdapter();
  if ("ok" in adapter) return adapter;
  try {
    const config = await adapter.getDomainConfig(store.customDomain);
    return { ok: true, domain: config.domain, verified: config.verified, cname: config.cname };
  } catch (e) {
    if (e instanceof VercelApiError) {
      return { ok: false, error: e.message, status: e.status };
    }
    throw e;
  }
}

export async function removeDomainFromStore(
  storeId: string,
): Promise<DomainResult> {
  const store = await platformAdmin.store.findUnique({
    where: { id: storeId },
  });
  if (!store) {
    return { ok: false, error: "Store not found", status: 404 };
  }
  if (!store.customDomain) {
    return { ok: false, error: "Store has no custom domain", status: 404 };
  }

  const oldDomain = store.customDomain;
  const adapter = vercelAdapter();
  if ("ok" in adapter) return adapter;
  try {
    await adapter.removeDomain(oldDomain);
  } catch (e) {
    if (e instanceof VercelApiError && e.status === 404) {
      // Domain already gone from Vercel — proceed to clean up DB
    } else if (e instanceof VercelApiError) {
      return { ok: false, error: e.message, status: e.status };
    } else {
      throw e;
    }
  }

  await platformAdmin.store.update({
    where: { id: storeId },
    data: { customDomain: null },
  });

  revalidateStore({ id: storeId, slug: store.slug, customDomain: oldDomain });

  return { ok: true, domain: oldDomain, verified: false, cname: "cname.vercel-dns.com" };
}
