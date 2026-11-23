"use client";
import Link from "next/link";
import { startTransition } from "react";
import { useParams, useRouter } from "next/navigation";
import { Button } from "../primitives";
import { FlowError } from "./common";
import "./order-flow.css";

/** The order lookup failed (not a missing order): say so, retry the server render, or go back to the order. */
export function OrderLookupError({ reset }: { reset: () => void }) {
  const router = useRouter();
  const { token } = useParams<{ token: string }>();
  return (
    <div className="of-wrap" style={{ maxWidth: 640 }}>
      <FlowError
        title="We couldn’t load this order"
        message="Something went wrong on our side. Your order and payment are safe. Try again in a moment."
      >
        <Button
          onClick={() =>
            startTransition(() => {
              router.refresh();
              reset();
            })
          }
        >
          Try again
        </Button>
        <Link href={`/order/${encodeURIComponent(token)}`} className="sf-text-link">
          Back to order
        </Link>
      </FlowError>
    </div>
  );
}
