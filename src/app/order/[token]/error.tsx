"use client";
import { FlowError } from "@/components/storefront/flow/common";
import { Button } from "@/components/storefront/primitives";
export default function Error({ reset }: { reset: () => void }) {
  return (
    <FlowError
      title="We couldn’t open your order"
      message="Something went wrong on our side. Your order and payment are safe. Try again in a moment."
    >
      <Button onClick={reset}>Try again</Button>
    </FlowError>
  );
}
