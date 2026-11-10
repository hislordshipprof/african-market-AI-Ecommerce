/**
 * The small markdown subset the assistant writes: **bold**, *italics*, bullet and
 * numbered lists, and [links](url). It parses to plain data that React renders as
 * text, so raw HTML can never become an element. Only https and same-site links
 * stay active; any other link keeps just its words.
 */
export type Inline =
  | { type: "text"; text: string }
  | { type: "strong"; children: Inline[] }
  | { type: "em"; children: Inline[] }
  | { type: "link"; href: string; external: boolean; children: Inline[] };

export type Block =
  | { type: "paragraph"; children: Inline[] }
  | { type: "list"; ordered: boolean; items: Inline[][] };

const BULLET = /^\s*[-*•]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
const LINK = /^\[([^\]\n]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/;

const BASE = "https://x.invalid";

/**
 * The one link check. A relative href is same-site only if it resolves on a fixed base
 * without leaving it (browsers read a backslash as a slash, so "/" + "\\host" is off-site).
 * Backslashes, control characters and "//" are refused outright; otherwise only https is allowed.
 */
export function linkTarget(href: string): { href: string; external: boolean } | null {
  if (/[\\\u0000-\u001f\u007f]/.test(href) || href.startsWith("//")) return null;
  let url: URL;
  try {
    url = new URL(href, BASE);
  } catch {
    return null;
  }
  if (!/^[a-z][a-z0-9+.-]*:/i.test(href)) {
    return url.origin === BASE && href.startsWith("/") ? { href: url.pathname + url.search + url.hash, external: false } : null;
  }
  return url.protocol === "https:" && url.origin !== BASE ? { href: url.href, external: true } : null;
}

function inline(source: string): Inline[] {
  const out: Inline[] = [];
  let text = "";
  const flush = () => {
    if (text) out.push({ type: "text", text });
    text = "";
  };
  let i = 0;
  while (i < source.length) {
    if (source.startsWith("**", i)) {
      const end = source.indexOf("**", i + 2);
      const inner = end > i + 2 ? source.slice(i + 2, end) : "";
      if (inner.trim() === inner && inner) {
        flush();
        out.push({ type: "strong", children: inline(inner) });
        i = end + 2;
        continue;
      }
    }
    if (source[i] === "*" && source[i + 1] !== "*") {
      const end = source.indexOf("*", i + 1);
      const inner = end > i + 1 ? source.slice(i + 1, end) : "";
      if (inner && inner.trim() === inner && source[end + 1] !== "*") {
        flush();
        out.push({ type: "em", children: inline(inner) });
        i = end + 1;
        continue;
      }
    }
    if (source[i] === "[") {
      const match = LINK.exec(source.slice(i));
      if (match) {
        flush();
        const target = linkTarget(match[2]);
        if (target) out.push({ type: "link", ...target, children: inline(match[1]) });
        else text = match[1];
        i += match[0].length;
        continue;
      }
    }
    text += source[i];
    i += 1;
  }
  flush();
  // Adjacent text nodes (an inactive link's words) read as one.
  return out.reduce<Inline[]>((merged, node) => {
    const last = merged[merged.length - 1];
    if (node.type === "text" && last?.type === "text") last.text += node.text;
    else merged.push(node);
    return merged;
  }, []);
}

export function parseMarkdown(source: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const endParagraph = () => {
    if (paragraph.length) blocks.push({ type: "paragraph", children: inline(paragraph.join("\n")) });
    paragraph = [];
  };
  for (const line of source.split(/\r?\n/)) {
    const bullet = BULLET.exec(line);
    const numbered = bullet ? null : NUMBERED.exec(line);
    if (bullet || numbered) {
      endParagraph();
      const ordered = !!numbered;
      const item = inline((bullet ?? numbered)![1]);
      const last = blocks[blocks.length - 1];
      if (last?.type === "list" && last.ordered === ordered) last.items.push(item);
      else blocks.push({ type: "list", ordered, items: [item] });
    } else if (line.trim() === "") {
      endParagraph();
    } else {
      paragraph.push(line);
    }
  }
  endParagraph();
  return blocks;
}

function plain(nodes: readonly Inline[]): string {
  return nodes.map((node) => (node.type === "text" ? node.text : plain(node.children))).join("");
}

/** The reply's words without markup, for the screen-reader announcement. */
export function markdownToPlain(source: string): string {
  return parseMarkdown(source)
    .flatMap((block) => (block.type === "paragraph" ? [plain(block.children)] : block.items.map(plain)))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}
