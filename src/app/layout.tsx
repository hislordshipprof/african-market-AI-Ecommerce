import type { Metadata } from "next";
import { Bricolage_Grotesque, Figtree, Geist } from "next/font/google";
import { headers } from "next/headers";
import { findStore, findStoreByDomain, type ValidatedStore } from "@/lib/get-store";
import { resolveStoreTheme, type ResolvedTheme } from "@/lib/theme";
import { Toaster } from "@/components/ui/sonner";
import "./globals.css";
import { cn } from "@/lib/utils";

const geist = Geist({subsets:['latin'],variable:'--font-sans'});

const bricolage = Bricolage_Grotesque({
  subsets: ["latin"],
  variable: "--font-display",
  display: "swap",
});

const figtree = Figtree({
  subsets: ["latin"],
  variable: "--font-body",
  display: "swap",
});

async function resolveStoreFromHeaders(): Promise<ValidatedStore | null> {
  const headerList = await headers();
  const slug = headerList.get("x-store-slug");
  if (slug) return findStore(slug);
  const customDomain = headerList.get("x-custom-domain");
  if (customDomain) return findStoreByDomain(customDomain);
  return null;
}

export async function generateMetadata(): Promise<Metadata> {
  const store = await resolveStoreFromHeaders();
  return { title: store?.name ?? "Store not found" };
}

function themeToCss(vars: Record<string, string>): string {
  return Object.entries(vars)
    .map(([k, v]) => `${k}:${v}`)
    .join(";");
}

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  let theme: ResolvedTheme | null = null;

  const store = await resolveStoreFromHeaders();
  if (store) {
    theme = resolveStoreTheme(
      store.validPreset,
      store.validBrandColor,
    );
  }

  const headerList = await headers();
  // Read by the story surface, for browsers that send Save-Data without navigator.connection.
  const saveData = headerList.get("save-data")?.toLowerCase() === "on" ? "on" : undefined;

  const themeStyle = theme
    ? `body{${themeToCss(theme.light)}}@media(prefers-color-scheme:dark){body{${themeToCss(theme.dark)}}}`
    : "";

  return (
    <html
      lang="en"
      data-save-data={saveData}
      className={cn(bricolage.variable, figtree.variable, "font-sans", geist.variable)}
    >
      <head>
        {themeStyle ? (
          <style dangerouslySetInnerHTML={{ __html: themeStyle }} />
        ) : null}
      </head>
      <body>
        {children}
        <Toaster />
      </body>
    </html>
  );
}
