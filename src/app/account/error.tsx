"use client";
import { FlowError } from "@/components/storefront/flow/common";
export default function Error({ retry }: { error: Error; retry: () => void }) {
  return (
    <div className="sf-container flow-page">
      <FlowError
        title="Your account could not load"
        message="Please try again."
      >
        <button className="sf-button" onClick={retry}>
          Try again
        </button>
      </FlowError>
    </div>
  );
}
