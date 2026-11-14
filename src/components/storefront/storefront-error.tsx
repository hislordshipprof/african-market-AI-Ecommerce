"use client";
import Link from "next/link";
import { AlertCircle } from "lucide-react";
export default function StorefrontError({ retry }: { retry: () => void }) {
  return (
    <main className="sf-storefront sf-section">
      <div className="sf-container sf-empty" role="alert">
        <span className="sf-empty-mark">
          <AlertCircle size={32} aria-hidden />
        </span>
        <h2>We couldn’t reach the shelves</h2>
        <p>
          Something interrupted the connection to your store. Your saved cart is
          still on this device.
        </p>
        <button className="sf-button" onClick={() => retry()}>
          Try again
        </button>
        <Link className="sf-text-link" href="/">
          Back to the store
        </Link>
      </div>
    </main>
  );
}
