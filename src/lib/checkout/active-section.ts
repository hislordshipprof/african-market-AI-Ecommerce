/**
 * Which checkout section the shopper is in: the last one, in page order, whose top has
 * scrolled to `line`. A section that sits beside the one before it (its top is higher,
 * like the sticky order summary on desktop) is not part of the scroll and is skipped.
 */
export function activeSection(
  sections: readonly { id: string; top: number }[],
  line: number,
): string | null {
  if (!sections.length) return null;
  let current = sections[0].id;
  let previousTop = -Infinity;
  for (const section of sections) {
    if (section.top < previousTop) continue;
    previousTop = section.top;
    if (section.top <= line) current = section.id;
  }
  return current;
}
