const KEYWORDS = new Set([
  "CREATE",
  "ALTER",
  "DROP",
  "TABLE",
  "INDEX",
  "UNIQUE",
  "IF",
  "NOT",
  "EXISTS",
  "ONLY",
  "CONCURRENTLY",
  "ON",
]);

function tokenize(sql: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === "-" && sql[i + 1] === "-") {
      i += 2;
      while (i < sql.length && sql[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) i += 1;
      i = Math.min(sql.length, i + 2);
      continue;
    }
    if (c === "'") {
      i += 1;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (c === '"') {
      i += 1;
      let ident = "";
      while (i < sql.length) {
        if (sql[i] === '"' && sql[i + 1] === '"') {
          ident += '"';
          i += 2;
          continue;
        }
        if (sql[i] === '"') {
          i += 1;
          break;
        }
        ident += sql[i];
        i += 1;
      }
      out.push(ident);
      continue;
    }
    if (c === ".") {
      out.push(".");
      i += 1;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let word = "";
      while (i < sql.length && /[A-Za-z0-9_]/.test(sql[i])) {
        word += sql[i];
        i += 1;
      }
      const upper = word.toUpperCase();
      out.push(KEYWORDS.has(upper) ? upper : word);
      continue;
    }
    i += 1;
  }
  return out;
}

function skipIfExists(tokens: string[], index: number): number {
  if (tokens[index] === "IF" && tokens[index + 1] === "NOT" && tokens[index + 2] === "EXISTS") {
    return index + 3;
  }
  if (tokens[index] === "IF" && tokens[index + 1] === "EXISTS") return index + 2;
  return index;
}

function readName(tokens: string[], index: number): { name: string; next: number } | null {
  const first = tokens[index];
  if (!first || KEYWORDS.has(first) || first === ".") return null;
  let name = first;
  let next = index + 1;
  while (tokens[next] === "." && tokens[next + 1] && !KEYWORDS.has(tokens[next + 1]) && tokens[next + 1] !== ".") {
    name = tokens[next + 1];
    next += 2;
  }
  return { name, next };
}

function sorted(names: Set<string>): string[] {
  return [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function rememberTable(found: Set<string>, tokens: string[], index: number): number | null {
  let j = skipIfExists(tokens, index);
  if (tokens[j] === "ONLY") j += 1;
  const table = readName(tokens, j);
  if (!table) return null;
  found.add(table.name);
  return table.next;
}

/** Tables a Prisma migrate-diff script changes. A referenced table is not changed. */
export function affectedTablesInMigrateDiff(
  script: string,
  indexToTable: ReadonlyMap<string, string> = new Map(),
): string[] {
  const found = new Set<string>();
  const tokens = tokenize(script);
  for (let i = 0; i < tokens.length; i += 1) {
    const action = tokens[i];
    if (action !== "ALTER" && action !== "DROP" && action !== "CREATE") continue;
    let j = i + 1;
    if (action === "CREATE" && tokens[j] === "UNIQUE") j += 1;
    if ((action === "DROP" || action === "CREATE") && tokens[j] === "CONCURRENTLY") j += 1;
    if (tokens[j] === "TABLE") {
      const next = rememberTable(found, tokens, j + 1);
      if (next !== null) i = next - 1;
      continue;
    }
    if (tokens[j] !== "INDEX") continue;
    j = skipIfExists(tokens, j + 1);
    const index = readName(tokens, j);
    if (!index) continue;
    if (action === "CREATE") {
      let k = index.next;
      while (
        k < tokens.length &&
        tokens[k] !== "ON" &&
        tokens[k] !== "CREATE" &&
        tokens[k] !== "ALTER" &&
        tokens[k] !== "DROP"
      ) {
        k += 1;
      }
      if (tokens[k] !== "ON") continue;
      const next = rememberTable(found, tokens, k + 1);
      if (next !== null) i = next - 1;
      continue;
    }
    found.add(indexToTable.get(index.name) ?? `unresolved index: ${index.name}`);
    i = index.next - 1;
  }
  return sorted(found);
}
