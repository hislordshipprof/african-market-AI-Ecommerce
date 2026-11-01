"use client";

import { FlowError } from "@/components/storefront/flow/common";

export default function CartError({
  retry,
}: {
  error: Error;
  retry: () => void;
}) {
  return (
    <div className="sf-container flow-page">
      <FlowError
        title="Your cart could not load"
        message="Your saved basket will be here when you try again."
      >
        <button className="sf-button" onClick={retry}>
          Try again
        </button>
      </FlowError>
    </div>
  );
}
