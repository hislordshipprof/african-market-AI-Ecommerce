import { linkTarget } from "@/lib/assistant/ui/markdown";

/** A same-site path to return to after sign-in: no backslash, and no encoded / or \ in the path (#712). */
export function isLocalCallbackPath(value: string): boolean {
  const path = value.split(/[?#]/, 1)[0];
  return linkTarget(value)?.external === false && !/%(2f|5c)/i.test(path);
}
