import Image from "next/image";
import Link from "next/link";
import type { ValidatedStore } from "@/lib/get-store";
import { SearchBar } from "./search-bar";

export function StorefrontHeader({ store }: { store: ValidatedStore }) {
  return (
    <header className="bg-primary">
      <div className="mx-auto max-w-6xl px-4 py-5 sm:px-6">
        <div className="flex items-center gap-3">
          {store.logoUrl && (
            <Image
              src={store.logoUrl}
              alt={`${store.name} logo`}
              width={48}
              height={48}
              className="h-12 w-12 rounded-md object-contain"
            />
          )}
          <Link href="/" className="min-w-0">
            <h1
              className="truncate font-display text-on-primary"
              style={{ fontSize: "clamp(20px, 3vw, 28px)", fontWeight: 700, lineHeight: 1.2 }}
            >
              {store.name}
            </h1>
          </Link>
        </div>

        <div className="mt-4">
          <SearchBar />
        </div>
      </div>
    </header>
  );
}
