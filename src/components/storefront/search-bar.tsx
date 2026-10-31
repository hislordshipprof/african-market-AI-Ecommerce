"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useTransition } from "react";

export function SearchBar() {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key !== "/") return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if ((e.target as HTMLElement)?.isContentEditable) return;
      e.preventDefault();
      inputRef.current?.focus();
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, []);

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    const q = (formData.get("q") as string).trim();
    if (!q) return;
    startTransition(() => {
      router.push(`/search?q=${encodeURIComponent(q)}`);
    });
  }

  return (
    <form
      ref={formRef}
      onSubmit={handleSubmit}
      className="relative w-full"
      role="search"
    >
      <label htmlFor="storefront-search" className="sr-only">
        Search listings — press / to focus
      </label>
      <input
        ref={inputRef}
        id="storefront-search"
        name="q"
        type="search"
        placeholder="Search by name, e.g. ugu, garri, egusi..."
        autoComplete="off"
        className="w-full min-h-[44px] rounded-pill border border-line bg-surface px-4 py-3 pl-10 pr-12 font-body text-sm text-ink placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
      />
      <svg
        className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
        xmlns="http://www.w3.org/2000/svg"
        fill="none"
        viewBox="0 0 24 24"
        strokeWidth={2}
        stroke="currentColor"
        aria-hidden="true"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z"
        />
      </svg>
      {isPending ? (
        <div className="absolute right-3 top-1/2 -translate-y-1/2">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
        </div>
      ) : (
        <kbd className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 hidden rounded-sm border border-line bg-raised px-1.5 py-0.5 font-body text-[10px] font-medium text-muted-foreground sm:inline-block">/</kbd>
      )}
    </form>
  );
}
