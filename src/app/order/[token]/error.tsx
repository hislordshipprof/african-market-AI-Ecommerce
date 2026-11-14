"use client";
import { FlowError } from "@/components/storefront/flow/common";
import { Button } from "@/components/storefront/primitives";
export default function Error({ reset }: { reset: () => void }) {
  return (
    <FlowError
      title="We couldn't open your order"
      message="Please try loading the order again."
    >
      <Button onClick={reset}>Try again</Button>
    </FlowError>
  );
}
