import type { ReactNode } from "react";
import { parseMarkdown, type Inline } from "@/lib/assistant/ui/markdown";

function renderInline(nodes: readonly Inline[]): ReactNode[] {
  return nodes.map((node, index) => {
    if (node.type === "text") return node.text;
    if (node.type === "strong") return <strong key={index}>{renderInline(node.children)}</strong>;
    if (node.type === "em") return <em key={index}>{renderInline(node.children)}</em>;
    // node.external comes from linkTarget(): verified same-site, or an allowed https link.
    return (
      <a key={index} href={node.href} {...(node.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
        {renderInline(node.children)}
      </a>
    );
  });
}

/** The assistant's reply as text, bold, italics, lists and safe links. Never raw HTML. */
export function AssistantMarkdown({ text, className }: { text: string; className?: string }) {
  const blocks = parseMarkdown(text);
  return (
    <div className={className}>
      {blocks.map((block, index) =>
        block.type === "paragraph" ? (
          <p key={index}>{renderInline(block.children)}</p>
        ) : block.ordered ? (
          <ol key={index}>{block.items.map((item, i) => <li key={i}>{renderInline(item)}</li>)}</ol>
        ) : (
          <ul key={index}>{block.items.map((item, i) => <li key={i}>{renderInline(item)}</li>)}</ul>
        ),
      )}
    </div>
  );
}
