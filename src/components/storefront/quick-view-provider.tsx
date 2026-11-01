"use client";
import { createContext, useContext, useState, type ReactNode } from "react";
import dynamic from "next/dynamic";
import type { StorefrontListing } from "@/lib/storefront/service";
const QuickView = dynamic(() => import("./quick-view").then(m => m.QuickView));
const Context = createContext<(listing: StorefrontListing) => void>(() => {});
const ImageTransitionContext = createContext<{ selected: string; select: (id: string) => void }>({ selected: "", select: () => {} });
export const useProductImageTransition = () => useContext(ImageTransitionContext);
export const useQuickView = () => useContext(Context);
export function QuickViewProvider({ children }: { children: ReactNode }) {
  const [listing, setListing] = useState<StorefrontListing | null>(null);
  const [selected, select] = useState("");
  return <ImageTransitionContext.Provider value={{ selected, select }}><Context.Provider value={setListing}>{children}{listing && <QuickView key={listing.id} listing={listing} onClose={() => setListing(null)} />}</Context.Provider></ImageTransitionContext.Provider>;
}
