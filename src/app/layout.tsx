import type { Metadata } from "next";
import { Bricolage_Grotesque, Figtree } from "next/font/google";
import { headers } from "next/headers";
import { findStore } from "@/lib/get-store";
import { resolveStoreTheme } from "@/lib/theme";
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

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  let themeVars: Record<string, string> = {};

  const headerList = await headers();
  const slug = headerList.get("x-store-slug");
  if (slug) {
    const store = await findStore(slug);
    if (store) {
      themeVars = resolveStoreTheme(store.validPreset, store.validBrandColor);
    }
  }

  return (
    <html lang="en" className={`${bricolage.variable} ${figtree.variable}`}>
      <body style={themeVars}>{children}</body>
    </html>
  );
}
