import { fakeLocate, fakeSuggest } from "./fake";
import type { AddressParts, StorePoint, Suggestion } from "./geo";
import { locateWithCensus, suggestFromPhoton, type LocateResult } from "./remote";

export interface AddressBackend {
  suggest(query: string, store: StorePoint): Promise<Suggestion[]>;
  locate(parts: AddressParts): Promise<LocateResult>;
}

export type AddressProviderKind = "fake" | "real";

/**
 * The fake is refused on Vercel and in production without CI. Refusal selects
 * the real Photon and Census adapters (no key) and the caller logs one warning.
 */
export function addressProviderKind(env: NodeJS.ProcessEnv = process.env): AddressProviderKind {
  const fake =
    env.E2E_FAKE_ADDRESS === "1" &&
    !env.VERCEL &&
    (env.CI === "true" || env.NODE_ENV !== "production");
  return fake ? "fake" : "real";
}

export function realAddressBackend(
  fetchImpl: typeof fetch,
  env: NodeJS.ProcessEnv = process.env,
): AddressBackend {
  return {
    suggest: (query, store) => suggestFromPhoton(query, store, fetchImpl, env),
    locate: (parts) => locateWithCensus(parts, fetchImpl, env),
  };
}

export function fakeAddressBackend(): AddressBackend {
  return {
    suggest: async (query) => fakeSuggest(query),
    locate: async (parts) => fakeLocate(parts),
  };
}

let override: AddressBackend | null = null;
let warned = false;

export function setAddressProvider(backend: AddressBackend | null): void {
  override = backend;
}

/** Selects the fake or the real adapter. Tests pass their own fetch into the real one. */
export function addressBackendFor(env: NodeJS.ProcessEnv, fetchImpl: typeof fetch): AddressBackend {
  if (addressProviderKind(env) === "fake") return fakeAddressBackend();
  if (env.NODE_ENV === "test" && fetchImpl === globalThis.fetch) {
    throw new Error("Real address adapter refused in tests without an injected fetch");
  }
  return realAddressBackend(fetchImpl, env);
}

export function getAddressProvider(env: NodeJS.ProcessEnv = process.env): AddressBackend {
  if (override) return override;
  const kind = addressProviderKind(env);
  if (kind === "fake") {
    if (!warned) {
      warned = true;
      console.warn(
        "E2E_FAKE_ADDRESS=1 is selecting the fake address provider. Refusing this on Vercel and on production without CI.",
      );
    }
    return fakeAddressBackend();
  }
  if (env.E2E_FAKE_ADDRESS === "1" && !warned) {
    warned = true;
    console.warn(
      "E2E_FAKE_ADDRESS=1 was refused. Using Photon and the Census Geocoder.",
    );
  }
  if (env.NODE_ENV === "test") {
    throw new Error("Real address adapter refused in tests without an injected fetch");
  }
  return realAddressBackend(fetch, env);
}
