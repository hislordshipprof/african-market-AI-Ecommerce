import fs from "node:fs";
import path from "node:path";

const IMPORT_RE = /(?:from\s+|import\s*\(\s*|require\(\s*)["']([^"']+)["']/g;

const FORBIDDEN_PACKAGES = new Set(["stripe"]);

export function findForbiddenImports(roots: string[], srcRoot: string): string[] {
  const hits: string[] = [];
  const seen = new Set<string>();
  const queue = roots.flatMap((root) => listModules(root));
  while (queue.length > 0) {
    const file = queue.pop();
    if (!file || seen.has(file)) continue;
    seen.add(file);
    const text = fs.readFileSync(file, "utf8");
    for (const match of text.matchAll(IMPORT_RE)) {
      const spec = match[1];
      if (!spec) continue;
      if (spec === "stripe" || spec.startsWith("@stripe/") || FORBIDDEN_PACKAGES.has(spec)) {
        hits.push(`${path.relative(srcRoot, file)} -> ${spec}`);
        continue;
      }
      const resolved = resolveSpecifier(file, spec, srcRoot);
      if (!resolved) continue;
      const normalized = resolved.replace(/\\/g, "/");
      if (normalized.endsWith("/lib/stripe/provider.ts") || normalized.endsWith("/lib/checkout/service.ts")) {
        hits.push(`${path.relative(srcRoot, file)} -> ${path.relative(srcRoot, resolved)}`);
      }
      if (resolved.startsWith(srcRoot) && !seen.has(resolved)) queue.push(resolved);
    }
  }
  return hits;
}

function listModules(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".test.ts")) found.push(full);
    }
  };
  walk(root);
  return found;
}

function resolveSpecifier(fromFile: string, spec: string, srcRoot: string): string | null {
  let target: string;
  if (spec.startsWith("@/")) target = path.join(srcRoot, spec.slice(2));
  else if (spec.startsWith(".")) target = path.resolve(path.dirname(fromFile), spec);
  else return null;
  const candidates = [target, `${target}.ts`, `${target}.tsx`, path.join(target, "index.ts")];
  return candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) ?? null;
}
