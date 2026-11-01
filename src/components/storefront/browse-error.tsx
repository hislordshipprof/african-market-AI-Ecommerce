"use client";
import Link from "next/link";
import { AlertCircle } from "lucide-react";
export function BrowseError({ retry }: { retry: () => void }) {
  return (
    <div className="sf-storefront">
      <div className="sf-container sf-section">
        <div className="sf-empty" role="alert">
          <span className="sf-empty-mark">
            <AlertCircle size={32} aria-hidden />
          </span>
          <h2 className="sf-page-title">The market could not load</h2>
          <p>
            Please try again. Your next favorite ingredient will be here when we
            reconnect.
          </p>
          <button className="sf-button" onClick={() => retry()}>
            Try again
          </button>
          <Link className="sf-text-link" href="/categories">
            Browse the aisles
          </Link>
        </div>
      </div>
    </div>
  );
}
