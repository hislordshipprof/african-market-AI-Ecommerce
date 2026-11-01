"use client";
import { BrowseError } from "@/components/storefront/browse-error";
export default function Error({
  retry,
}: {
  error: unknown;
  retry: () => void;
}) {
  return <BrowseError retry={retry} />;
}
