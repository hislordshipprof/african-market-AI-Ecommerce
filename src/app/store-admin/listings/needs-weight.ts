export function listingNeedsWeight(listing: {
  variants: { weightPlaceholder: boolean }[];
}): boolean {
  return listing.variants.some((variant) => variant.weightPlaceholder);
}

export function editWeightField(variant: {
  weightG: number;
  weightPlaceholder: boolean;
}): { value: string; placeholder: string } {
  if (variant.weightPlaceholder) {
    return { value: "", placeholder: "Needs weight" };
  }
  return { value: String(variant.weightG), placeholder: "Weight (g)" };
}

export function needsWeightSentence(count: number): string | null {
  if (count <= 0) return null;
  if (count === 1) return "1 listing needs a weight.";
  return `${count} listings need a weight.`;
}
