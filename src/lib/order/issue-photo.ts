// No server imports: the report form reads these too.
export const ISSUE_TYPES = ["missing", "damaged", "wrong", "poor_freshness"] as const;
export type IssueType = (typeof ISSUE_TYPES)[number];

export const ISSUE_PHOTO_INVALID = "Add one photo of the problem: a JPEG, PNG or WebP image.";

/** A missing item has nothing to photograph; every other problem needs one photo (#743). */
export function issuePhotoRequired(type: IssueType): boolean {
  return type !== "missing";
}
