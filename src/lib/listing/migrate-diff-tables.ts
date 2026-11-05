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

/** A quoted identifier stays a name, even when its text is a keyword. Only an unquoted keyword is syntax. */
type Token = { kind: "kw"; value: string } | { kind: "id"; value: string } | { kind: "dot" };

function isKw(token: Token | undefined, word: string): boolean {
  return token?.kind === "kw" && token.value === word;
}

function tokenize(sql: string): Token[] {
  const out: Token[] = [];
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
      out.push({ kind: "id", value: ident });
      continue;
    }
    if (c === ".") {
      out.push({ kind: "dot" });
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
      out.push(KEYWORDS.has(upper) ? { kind: "kw", value: upper } : { kind: "id", value: word });
      continue;
    }
    i += 1;
  }
  return out;
}

function skipIfExists(tokens: Token[], index: number): number {
  if (isKw(tokens[index], "IF") && isKw(tokens[index + 1], "NOT") && isKw(tokens[index + 2], "EXISTS")) {
    return index + 3;
  }
  if (isKw(tokens[index], "IF") && isKw(tokens[index + 1], "EXISTS")) return index + 2;
  return index;
}

function readName(tokens: Token[], index: number): { name: string; next: number } | null {
  const first = tokens[index];
  if (first?.kind !== "id") return null;
  let name = first.value;
  let next = index + 1;
  while (tokens[next]?.kind === "dot") {
    const second = tokens[next + 1];
    if (second?.kind !== "id") break;
    name = second.value;
    next += 2;
  }
  return { name, next };
}

function sorted(names: Set<string>): string[] {
  return [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function rememberTable(found: Set<string>, tokens: Token[], index: number): number | null {
  let j = skipIfExists(tokens, index);
  if (isKw(tokens[j], "ONLY")) j += 1;
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
    if (!isKw(action, "ALTER") && !isKw(action, "DROP") && !isKw(action, "CREATE")) continue;
    let j = i + 1;
    if (isKw(action, "CREATE") && isKw(tokens[j], "UNIQUE")) j += 1;
    if (isKw(tokens[j], "TABLE")) {
      const next = rememberTable(found, tokens, j + 1);
      if (next !== null) i = next - 1;
      continue;
    }
    if (!isKw(tokens[j], "INDEX")) continue;
    j += 1;
    if ((isKw(action, "DROP") || isKw(action, "CREATE")) && isKw(tokens[j], "CONCURRENTLY")) j += 1;
    j = skipIfExists(tokens, j);
    const index = readName(tokens, j);
    if (!index) continue;
    if (isKw(action, "CREATE")) {
      let k = index.next;
      while (
        k < tokens.length &&
        !isKw(tokens[k], "ON") &&
        !isKw(tokens[k], "CREATE") &&
        !isKw(tokens[k], "ALTER") &&
        !isKw(tokens[k], "DROP")
      ) {
        k += 1;
      }
      if (!isKw(tokens[k], "ON")) continue;
      const next = rememberTable(found, tokens, k + 1);
      if (next !== null) i = next - 1;
      continue;
    }
    found.add(indexToTable.get(index.name) ?? `unresolved index: ${index.name}`);
    i = index.next - 1;
  }
  return sorted(found);
}
