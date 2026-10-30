import Image from "next/image";
import { getStore } from "@/lib/get-store";

export default async function StorefrontPage() {
  const store = await getStore();

  return (
    <main className="min-h-screen bg-bg">
      <header className="bg-primary px-md py-lg">
        <div className="mx-auto max-w-5xl">
          {store.logoUrl && (
            <Image
              src={store.logoUrl}
              alt={`${store.name} logo`}
              width={160}
              height={64}
              className="mb-sm h-16 w-auto"
            />
          )}
          <h1 className="text-display text-on-primary">{store.name}</h1>
        </div>
      </header>

      <section className="mx-auto max-w-5xl px-md py-xl">
        <div className="rounded-lg bg-surface p-lg">
          <p className="text-body text-muted">
            Storefront coming soon. Check back for listings.
          </p>
        </div>
      </section>

      <footer className="border-t border-line px-md py-lg text-center">
        <p className="text-body text-muted">Powered by the Platform</p>
      </footer>
    </main>
  );
}
