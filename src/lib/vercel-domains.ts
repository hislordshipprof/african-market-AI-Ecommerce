export interface DomainAddResult {
  domain: string;
  verified: boolean;
  cname: string;
}

export interface DomainConfigResult {
  domain: string;
  verified: boolean;
  cname: string;
}

export interface DomainRemoveResult {
  domain: string;
  removed: true;
}

export interface VercelDomainsAdapter {
  addDomain(domain: string): Promise<DomainAddResult>;
  getDomainConfig(domain: string): Promise<DomainConfigResult>;
  removeDomain(domain: string): Promise<DomainRemoveResult>;
}

export class VercelApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "VercelApiError";
  }
}

function requireKey(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is required for Vercel domain operations. ` +
        `Set it in .env.local or provide it at deploy time.`,
    );
  }
  return value;
}

const VERCEL_TIMEOUT_MS = 10_000;

async function vercelFetch(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VERCEL_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (e) {
    if (controller.signal.aborted) {
      throw new VercelApiError("Vercel API did not respond in time", 504, "timeout");
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export class RealVercelDomainsAdapter implements VercelDomainsAdapter {
  private getHeaders(): { Authorization: string; "Content-Type": string } {
    const token = requireKey("VERCEL_TOKEN");
    return {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };
  }

  private getProjectId(): string {
    return requireKey("VERCEL_PROJECT_ID");
  }

  private getTeamParam(): string {
    const teamId = process.env.VERCEL_TEAM_ID;
    return teamId ? `?teamId=${teamId}` : "";
  }

  async addDomain(domain: string): Promise<DomainAddResult> {
    const projectId = this.getProjectId();
    const headers = this.getHeaders();
    const teamParam = this.getTeamParam();

    let attempts = 0;
    const maxAttempts = 3;

    while (attempts < maxAttempts) {
      const res = await vercelFetch(
        `https://api.vercel.com/v10/projects/${projectId}/domains${teamParam}`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ name: domain }),
        },
      );

      if (res.status === 429) {
        attempts++;
        if (attempts >= maxAttempts) {
          throw new VercelApiError("Rate limited by Vercel API", 429, "rate_limited");
        }
        const delay = Math.pow(2, attempts) * 1000;
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      if (res.status === 409) {
        throw new VercelApiError(
          "Domain is already in use by another project",
          409,
          "domain_already_in_use",
        );
      }

      if (!res.ok) {
        const body = await res.text();
        throw new VercelApiError(
          `Vercel API error: ${res.status} ${body}`,
          res.status,
        );
      }

      const data = await res.json();
      return {
        domain: data.name ?? domain,
        verified: data.verified ?? false,
        cname: "cname.vercel-dns.com",
      };
    }

    throw new VercelApiError("Exhausted retries", 429, "rate_limited");
  }

  async getDomainConfig(domain: string): Promise<DomainConfigResult> {
    const projectId = this.getProjectId();
    const headers = this.getHeaders();
    const teamParam = this.getTeamParam();

    const res = await vercelFetch(
      `https://api.vercel.com/v10/projects/${projectId}/domains/${domain}${teamParam}`,
      { headers },
    );

    if (res.status === 404) {
      throw new VercelApiError("Domain not found", 404, "not_found");
    }

    if (!res.ok) {
      const body = await res.text();
      throw new VercelApiError(
        `Vercel API error: ${res.status} ${body}`,
        res.status,
      );
    }

    const data = await res.json();
    return {
      domain: data.name ?? domain,
      verified: data.verified ?? false,
      cname: "cname.vercel-dns.com",
    };
  }

  async removeDomain(domain: string): Promise<DomainRemoveResult> {
    const projectId = this.getProjectId();
    const headers = this.getHeaders();
    const teamParam = this.getTeamParam();

    const res = await vercelFetch(
      `https://api.vercel.com/v10/projects/${projectId}/domains/${domain}${teamParam}`,
      { method: "DELETE", headers },
    );

    if (res.status === 404) {
      throw new VercelApiError("Domain not found", 404, "not_found");
    }

    if (!res.ok) {
      const body = await res.text();
      throw new VercelApiError(
        `Vercel API error: ${res.status} ${body}`,
        res.status,
      );
    }

    return { domain, removed: true };
  }
}

export class FakeVercelDomainsAdapter implements VercelDomainsAdapter {
  private domains = new Map<string, { verified: boolean }>();

  async addDomain(domain: string): Promise<DomainAddResult> {
    if (this.domains.has(domain)) {
      throw new VercelApiError(
        "Domain is already in use by another project",
        409,
        "domain_already_in_use",
      );
    }
    this.domains.set(domain, { verified: false });
    return { domain, verified: false, cname: "cname.vercel-dns.com" };
  }

  async getDomainConfig(domain: string): Promise<DomainConfigResult> {
    const entry = this.domains.get(domain);
    if (!entry) {
      throw new VercelApiError("Domain not found", 404, "not_found");
    }
    return { domain, verified: entry.verified, cname: "cname.vercel-dns.com" };
  }

  async removeDomain(domain: string): Promise<DomainRemoveResult> {
    if (!this.domains.has(domain)) {
      throw new VercelApiError("Domain not found", 404, "not_found");
    }
    this.domains.delete(domain);
    return { domain, removed: true };
  }

  setVerified(domain: string, verified: boolean): void {
    const entry = this.domains.get(domain);
    if (entry) entry.verified = verified;
  }
}

let _adapter: VercelDomainsAdapter | undefined;

// The fake is for tests and local dev only; a deployment without keys must fail, not pretend.
export function createVercelDomainsAdapter(
  env: Record<string, string | undefined> = process.env,
): VercelDomainsAdapter {
  const keyless = !env.VERCEL_TOKEN && !env.VERCEL_PROJECT_ID;
  const localOnly = (env.NODE_ENV === "test" || env.NODE_ENV === "development") && !env.VERCEL;
  if (keyless && localOnly) return new FakeVercelDomainsAdapter();
  for (const name of ["VERCEL_TOKEN", "VERCEL_PROJECT_ID"]) {
    if (!env[name]) {
      throw new Error(
        `${name} is required for Vercel domain operations outside tests and local dev.`,
      );
    }
  }
  return new RealVercelDomainsAdapter();
}

export function getVercelDomainsAdapter(): VercelDomainsAdapter {
  _adapter ??= createVercelDomainsAdapter();
  return _adapter;
}

export function setVercelDomainsAdapter(adapter: VercelDomainsAdapter): void {
  _adapter = adapter;
}

export function resetVercelDomainsAdapter(): void {
  _adapter = undefined;
}
