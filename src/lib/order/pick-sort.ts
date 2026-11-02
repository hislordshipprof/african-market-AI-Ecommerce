export function sortPickListLines<T extends { frozen: boolean; perishable: boolean }>(
  lines: T[],
): T[] {
  return [...lines].sort((a, b) => {
    const tierA = a.frozen ? 2 : a.perishable ? 1 : 0;
    const tierB = b.frozen ? 2 : b.perishable ? 1 : 0;
    return tierA - tierB;
  });
}
