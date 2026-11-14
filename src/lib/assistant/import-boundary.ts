import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

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
    for (const spec of importSpecifiers(text, file)) {
      if (forbiddenSpecifier(spec)) {
        hits.push(`${path.relative(srcRoot, file)} -> ${spec}`);
        continue;
      }
      const resolved = resolveSpecifier(file, spec, srcRoot);
      if (!resolved) continue;
      const normalized = resolved.replace(/\\/g, "/");
      if (forbiddenResolved(normalized)) {
        hits.push(`${path.relative(srcRoot, file)} -> ${path.relative(srcRoot, resolved)}`);
      }
      if (resolved.startsWith(srcRoot) && !seen.has(resolved)) queue.push(resolved);
    }
  }
  return hits;
}

const ACCOUNT_LOADERS = [
  "customer-account/checkout-profile",
  "customer-account/saved-cards",
  "customer-account/address-book",
];

/** Modules that create a PaymentIntent, pay with a saved card, or call placeOrder (#247). */
const PAYMENT_MODULES = [
  "stripe/provider",
  "stripe/checkout-payments",
  "checkout/service",
  "checkout/actions",
  "checkout/saved-card-payment",
];

function forbiddenResolved(normalized: string): boolean {
  return [...PAYMENT_MODULES, ...ACCOUNT_LOADERS].some((module) => normalized.endsWith(`/lib/${module}.ts`));
}

function forbiddenSpecifier(spec: string): boolean {
  return spec === "stripe"
    || spec.startsWith("@stripe/")
    || FORBIDDEN_PACKAGES.has(spec)
    || [...PAYMENT_MODULES, ...ACCOUNT_LOADERS].some((module) => spec === `@/lib/${module}` || spec.endsWith(`/lib/${module}`));
}

/** Import, re-export, import(), and require() specifiers, including side-effect imports. */
function importSpecifiers(text: string, fileName: string): string[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const specs: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier
      && ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specs.push(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node)) {
      const imported = node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === "require");
      const arg = node.arguments[0];
      if (imported && arg && ts.isStringLiteral(arg)) specs.push(arg.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return specs;
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
