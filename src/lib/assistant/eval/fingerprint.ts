import { ASSISTANT_STEP_CAP } from "../chat-handler";
import { canonicalJson, sha256 } from "./canonical";
import type { CatalogFixture, EvalCase } from "./types";

export interface MasterCatalogRow {
  id: string;
  name: string;
  categoryId: string | null;
  synonyms: string[];
}

export interface FingerprintParts {
  staticPrompt: string;
  storeContext: string;
  tools: unknown;
  requestParams: {
    model: string;
    maxTokens: number;
    thinking: unknown;
    effort: unknown;
  };
  stepCap: number;
  dataset: EvalCase[];
  fixture: CatalogFixture;
  masterCatalog: MasterCatalogRow[];
}

export interface Fingerprint {
  sha256: string;
  parts: Record<string, string>;
}

const PART_LABELS: Record<string, string> = {
  staticPrompt: "static prompt",
  storeContext: "store context",
  tools: "tool definitions",
  requestParams: "model or request parameters",
  stepCap: "step cap",
  dataset: "dataset",
  fixture: "catalog fixture",
  masterCatalog: "master product names, synonyms, or categories",
};

export function fingerprintFromRequest(
  body: Record<string, unknown>,
  sources: {
    dataset: EvalCase[];
    fixture: CatalogFixture;
    masterCatalog: MasterCatalogRow[];
    stepCap?: number;
  },
): Fingerprint {
  const system = Array.isArray(body.system) ? body.system : [];
  const first = system[0] as { text?: unknown } | undefined;
  const second = system[1] as { text?: unknown } | undefined;
  const output = body.output_config as { effort?: unknown } | undefined;
  return fingerprintFromParts({
    staticPrompt: typeof first?.text === "string" ? first.text : "",
    storeContext: typeof second?.text === "string" ? second.text : "",
    tools: body.tools ?? [],
    requestParams: {
      model: typeof body.model === "string" ? body.model : "",
      maxTokens: typeof body.max_tokens === "number" ? body.max_tokens : -1,
      thinking: body.thinking ?? null,
      effort: output?.effort ?? null,
    },
    stepCap: sources.stepCap ?? ASSISTANT_STEP_CAP,
    dataset: sources.dataset,
    fixture: sources.fixture,
    masterCatalog: canonicalizeCatalog(sources.masterCatalog),
  });
}

export function fingerprintFromParts(parts: FingerprintParts): Fingerprint {
  const canonical: FingerprintParts = {
    ...parts,
    masterCatalog: canonicalizeCatalog(parts.masterCatalog),
  };
  const hashed: Record<string, string> = {};
  for (const key of Object.keys(canonical).sort()) {
    hashed[key] = sha256(canonical[key as keyof FingerprintParts]);
  }
  return { sha256: sha256(canonical), parts: hashed };
}

export function changedFingerprintParts(committed: Fingerprint, current: Fingerprint): string[] {
  const keys = new Set([...Object.keys(committed.parts), ...Object.keys(current.parts)]);
  return [...keys].filter((key) => committed.parts[key] !== current.parts[key]).map((key) => PART_LABELS[key] ?? key);
}

export function canonicalizeCatalog(rows: MasterCatalogRow[]): MasterCatalogRow[] {
  return [...rows]
    .map((row) => ({
      id: row.id,
      name: row.name,
      categoryId: row.categoryId,
      synonyms: [...row.synonyms].sort(),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function requestBodyForFingerprint(body: Record<string, unknown> | null): Record<string, unknown> {
  if (!body) return {};
  const copy = { ...body };
  delete copy.messages;
  delete copy.stream;
  return copy;
}

export function fingerprintPayloadJson(parts: FingerprintParts): string {
  return canonicalJson({
    ...parts,
    masterCatalog: canonicalizeCatalog(parts.masterCatalog),
  });
}
