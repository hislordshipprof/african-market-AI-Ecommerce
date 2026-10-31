import type { Metadata } from "next";
import { Bricolage_Grotesque, Figtree } from "next/font/google";
import { headers } from "next/headers";
import { findStore } from "@/lib/get-store";
import { resolveStoreTheme, type ResolvedTheme } from "@/lib/theme";
import "./globals.css";

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

export async function generateMetadata(): Promise<Metadata> {
  const headerList = await headers();
  const slug = headerList.get("x-store-slug");
  if (!slug) return { title: "Store not found" };
  const store = await findStore(slug);
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

  const headerList = await headers();
  const slug = headerList.get("x-store-slug");
  if (slug) {
    const store = await findStore(slug);
    if (store) {
      theme = resolveStoreTheme(store.validPreset, store.validBrandColor);
    }
  }

  const themeStyle = theme
    ? `body{${themeToCss(theme.light)}}@media(prefers-color-scheme:dark){body{${themeToCss(theme.dark)}}}`
    : "";

  return (
    <html lang="en" className={`${bricolage.variable} ${figtree.variable}`}>
      <head>
        {themeStyle ? (
          <style dangerouslySetInnerHTML={{ __html: themeStyle }} />
        ) : null}
      </head>
      <body>{children}</body>
    </html>
  );
}
