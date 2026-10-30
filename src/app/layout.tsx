import type { Metadata } from "next";
import { Bricolage_Grotesque, Figtree } from "next/font/google";
import { getStore } from "@/lib/get-store";
import { resolveStoreTheme, type ThemePreset } from "@/lib/theme";
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
  let title = "Store not found";
  try {
    const store = await getStore();
    title = store.name;
  } catch {
    // notFound() throws — caught by not-found page
  }
  return { title };
}

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  let themeVars: Record<string, string> = {};
  try {
    const store = await getStore();
    themeVars = resolveStoreTheme(
      store.themePreset as ThemePreset,
      store.brandColor,
    );
  } catch {
    // notFound() throws — layout still renders for the not-found page
  }

  return (
    <html lang="en" className={`${bricolage.variable} ${figtree.variable}`}>
      <body style={themeVars}>{children}</body>
    </html>
  );
}
