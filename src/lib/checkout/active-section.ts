/**
 * Which checkout section the shopper is in: the last one whose top has scrolled to `line`
 * (the sticky header's bottom), or the last one when the page is scrolled to its end.
 */
export function activeSection(
  sections: readonly { id: string; top: number }[],
  line: number,
  atEnd = false,
): string | null {
  if (!sections.length) return null;
  if (atEnd) return sections[sections.length - 1].id;
  let current = sections[0].id;
  for (const section of sections) {
    if (section.top <= line) current = section.id;
  }
  return current;
}
