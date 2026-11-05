type FormKind = "table" | "table-list" | "index" | "index-list" | "index-on";
type Span = { start: number; end: number };

const FORMS: Array<{ kind: FormKind; source: string }> = [
  { kind: "table", source: String.raw`\balter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?` },
  { kind: "table", source: String.raw`\bcreate\s+table\s+(?:if\s+not\s+exists\s+)?` },
  { kind: "table-list", source: String.raw`\bdrop\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?` },
  { kind: "index-on", source: String.raw`\bcreate\s+(?:unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?` },
  { kind: "table-list", source: String.raw`\btruncate\s+(?:table\s+)?(?:only\s+)?` },
  { kind: "table", source: String.raw`\bcomment\s+on\s+table\s+` },
  { kind: "index-list", source: String.raw`\bdrop\s+index\s+(?:concurrently\s+)?(?:if\s+exists\s+)?` },
  { kind: "index", source: String.raw`\balter\s+index\s+(?:if\s+exists\s+)?` },
];

const UNHANDLED =
  /\b(?:create|insert|truncate|do)\b|\b(?:alter|drop)\s+(?:table|index|type|view|trigger|function|procedure|schema|sequence|domain)\b|\b(?:update|delete)\b|\bcomment\s+on\b|\brename\b(?!\s+(?:to|column|constraint)\b)/i;

function withoutClauses(text: string): string {
  return text.replace(/\bon\s+(?:update|delete)\b/gi, (clause) => " ".repeat(clause.length));
}

function withoutLineComments(script: string): string {
  return script
    .split(/\r?\n/)
    .filter((line) => !line.startsWith("--"))
    .join("\n");
}

function skipSpace(text: string, i: number): number {
  while (i < text.length && /\s/.test(text[i])) i += 1;
  return i;
}

function continuesIdentifier(char: string | undefined): boolean {
  if (!char) return false;
  return char === "$" || char.charCodeAt(0) > 127;
}

function readIdent(text: string, i: number): { name: string; end: number } {
  const start = skipSpace(text, i);
  const rest = text.slice(start);
  if (rest.startsWith('"')) {
    let name = "";
    for (let j = 1; j < rest.length; j += 1) {
      if (rest[j] !== '"') {
        name += rest[j];
        continue;
      }
      if (rest[j + 1] === '"') {
        name += '"';
        j += 1;
        continue;
      }
      const end = start + j + 1;
      if (continuesIdentifier(text[end])) {
        throw new Error(`migrate diff identifier was cut short: ${text.slice(start, end + 16).trim()}`);
      }
      return { name, end };
    }
    throw new Error(`migrate diff identifier was not readable: ${rest.slice(0, 80)}`);
  }
  const bare = /^[A-Za-z_]\w*/.exec(rest);
  if (!bare) throw new Error(`migrate diff identifier was not readable: ${rest.slice(0, 80)}`);
  const end = start + bare[0].length;
  if (continuesIdentifier(text[end])) {
    throw new Error(`migrate diff identifier was cut short: ${text.slice(start, end + 16).trim()}`);
  }
  return { name: bare[0], end };
}

function readQual(text: string, i: number): { name: string; end: number } {
  let current = readIdent(text, i);
  let end = current.end;
  for (;;) {
    const dot = skipSpace(text, end);
    if (text[dot] !== ".") break;
    current = readIdent(text, dot + 1);
    end = current.end;
  }
  return { name: current.name, end };
}

function readTargets(text: string, start: number, allowList: boolean): { names: string[]; end: number } {
  const names: string[] = [];
  let cursor = start;
  for (;;) {
    const qual = readQual(text, cursor);
    names.push(qual.name);
    let end = qual.end;
    let pos = skipSpace(text, end);
    if (text[pos] === "*") {
      end = pos + 1;
      pos = skipSpace(text, end);
    }
    if (text[pos] !== ",") return { names, end };
    if (!allowList) {
      throw new Error(`migrate diff has an unexamined target tail: ${text.slice(start, start + 160).trim()}`);
    }
    cursor = pos + 1;
  }
}

function requireSemicolon(text: string, start: number): void {
  if (text.indexOf(";", start) < 0) {
    throw new Error(`migrate diff statement has no semicolon: ${text.slice(start, start + 160).trim()}`);
  }
}

function parseAt(kind: FormKind, text: string, nameStart: number): { names: string[]; end: number; indexes: boolean } {
  if (kind === "index-on") {
    const indexName = readQual(text, nameStart);
    let pos = skipSpace(text, indexName.end);
    if (!/^on\b/i.test(text.slice(pos))) {
      throw new Error(`migrate diff index has no table: ${indexName.name}: ${text.slice(nameStart, nameStart + 160).trim()}`);
    }
    pos = skipSpace(text, pos + 2);
    if (/^only\b/i.test(text.slice(pos))) pos = skipSpace(text, pos + 4);
    return { ...readTargets(text, pos, true), indexes: false };
  }
  const indexes = kind === "index" || kind === "index-list";
  const allowList = kind === "table-list" || kind === "index-list";
  return { ...readTargets(text, nameStart, allowList), indexes };
}

function blank(text: string, spans: Span[]): string {
  const hidden = new Array<boolean>(text.length).fill(false);
  for (const span of spans) {
    for (let i = span.start; i < span.end && i < text.length; i += 1) hidden[i] = true;
  }
  let out = "";
  for (let i = 0; i < text.length; i += 1) out += hidden[i] ? " " : text[i];
  return out;
}

/**
 * Tables a Prisma migrate-diff script might change.
 * Strings and block comments are not skipped. Only the form and the targets actually read are removed,
 * so a later statement or a further target cannot disappear behind the first name.
 */
export function affectedTablesInMigrateDiff(
  script: string,
  indexToTable: ReadonlyMap<string, string> = new Map(),
): string[] {
  const text = withoutLineComments(script);
  const found = new Set<string>();
  const spans: Span[] = [];
  for (const form of FORMS) {
    for (const match of text.matchAll(new RegExp(form.source, "gi"))) {
      if (match.index === undefined) continue;
      requireSemicolon(text, match.index);
      const parsed = parseAt(form.kind, text, match.index + match[0].length);
      if (parsed.indexes) {
        for (const name of parsed.names) {
          const table = indexToTable.get(name);
          if (!table) {
            throw new Error(
              `migrate diff index has no table: ${name}: ${text.slice(match.index, parsed.end).trim()}`,
            );
          }
          found.add(table);
        }
      } else {
        for (const name of parsed.names) found.add(name);
      }
      spans.push({ start: match.index, end: parsed.end });
    }
  }
  const rest = blank(text, spans);
  const unhandled = UNHANDLED.exec(withoutClauses(rest));
  if (unhandled && unhandled.index !== undefined) {
    throw new Error(
      `migrate diff has an unhandled statement: ${rest.slice(unhandled.index, unhandled.index + 160).trim()}`,
    );
  }
  return [...found].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
