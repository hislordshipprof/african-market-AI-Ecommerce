"use client";

import { FlowError } from "@/components/storefront/flow/common";

export default function CheckoutError({
  retry,
}: {
  error: Error;
  retry: () => void;
}) {
  return (
    <div className="sf-container flow-page">
      <FlowError
        title="Checkout could not load"
        message="Your cart is saved. Please try again to review your order."
      >
        <button className="sf-button" onClick={retry}>
          Try again
        </button>
      </FlowError>
    </div>
  );
}
