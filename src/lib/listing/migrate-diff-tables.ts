const IDENT = String.raw`"(?:[^"]|"")*"|[A-Za-z_]\w*`;
const QUAL = `(?:${IDENT})(?:\\s*\\.\\s*(?:${IDENT}))?`;

const TABLE_FORMS = [
  String.raw`\balter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(${QUAL})`,
  String.raw`\bcreate\s+table\s+(?:if\s+not\s+exists\s+)?(${QUAL})`,
  String.raw`\bdrop\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(${QUAL})`,
  String.raw`\bcreate\s+(?:unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?${QUAL}\s+on\s+(?:only\s+)?(${QUAL})`,
  String.raw`\btruncate\s+(?:table\s+)?(?:only\s+)?(${QUAL})`,
  String.raw`\bcomment\s+on\s+table\s+(${QUAL})`,
];

const INDEX_FORMS = [
  String.raw`\bdrop\s+index\s+(?:concurrently\s+)?(?:if\s+exists\s+)?(${QUAL})`,
  String.raw`\balter\s+index\s+(?:if\s+exists\s+)?(${QUAL})`,
];

const UNHANDLED =
  /\b(?:create|alter|drop|truncate|delete|update|insert|rename|do)\b|\bcomment\s+on\b/i;

type Span = { start: number; end: number };

function withoutLineComments(script: string): string {
  return script
    .split(/\r?\n/)
    .filter((line) => !line.startsWith("--"))
    .join("\n");
}

function bare(qualified: string): string {
  const parts = qualified.match(/"(?:[^"]|"")*"|[A-Za-z_]\w*/g);
  const last = parts?.at(-1);
  if (!last) throw new Error(`migrate diff table name was not readable: ${qualified}`);
  if (last.startsWith('"')) return last.slice(1, -1).replaceAll('""', '"');
  return last;
}

function statementEnd(text: string, start: number): number {
  const semi = text.indexOf(";", start);
  if (semi < 0) {
    throw new Error(`migrate diff statement has no semicolon: ${text.slice(start, start + 160).trim()}`);
  }
  return semi + 1;
}

function matches(text: string, source: string): Array<{ name: string; start: number; end: number }> {
  const found: Array<{ name: string; start: number; end: number }> = [];
  for (const match of text.matchAll(new RegExp(source, "gi"))) {
    const raw = match[1];
    if (!raw || match.index === undefined) continue;
    found.push({ name: bare(raw), start: match.index, end: statementEnd(text, match.index) });
  }
  return found;
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
 * Strings and block comments are not skipped, so a table named inside one still counts.
 * An unrecognized statement throws. A false alarm fails the exact-set check; a hidden table does not pass.
 */
export function affectedTablesInMigrateDiff(
  script: string,
  indexToTable: ReadonlyMap<string, string> = new Map(),
): string[] {
  const text = withoutLineComments(script);
  const found = new Set<string>();
  const spans: Span[] = [];
  for (const source of TABLE_FORMS) {
    for (const match of matches(text, source)) {
      found.add(match.name);
      spans.push(match);
    }
  }
  for (const source of INDEX_FORMS) {
    for (const match of matches(text, source)) {
      const table = indexToTable.get(match.name);
      if (!table) {
        throw new Error(
          `migrate diff index has no table: ${match.name}: ${text.slice(match.start, match.end).trim()}`,
        );
      }
      found.add(table);
      spans.push(match);
    }
  }
  const rest = blank(text, spans);
  const unhandled = UNHANDLED.exec(rest);
  if (unhandled && unhandled.index !== undefined) {
    throw new Error(
      `migrate diff has an unhandled statement: ${rest.slice(unhandled.index, unhandled.index + 160).trim()}`,
    );
  }
  return [...found].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
