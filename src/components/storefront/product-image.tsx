"use client";
import Image from "next/image";
import { useState } from "react";
import { ImageOff, Carrot, Wheat, Leaf, Fish, CupSoda, CookingPot, Package, Droplets, Cookie, Sparkles } from "lucide-react";
import { isRetiredRemote } from "@/lib/storefront/editorial";

const glyphs = {
  "tubers-and-roots": Carrot, "grains-and-flours": Wheat, vegetables: Leaf,
  "fish-and-meat": Fish, frozen: Fish, drinks: CupSoda,
  "spices-and-seasonings": CookingPot, "pantry-staples": Wheat,
  "oils-and-butters": Droplets, snacks: Cookie, beauty: Sparkles,
};

export function ProductImage({
  src, name, category, sizes = "(max-width: 767px) 44vw, 320px", priority = false,
}: { src?: string; name: string; category?: string; sizes?: string; priority?: boolean }) {
  const accepted = src && !isRetiredRemote(src) ? src : undefined;
  return <ProductPhoto key={accepted || "missing"} src={accepted} name={name} category={category} sizes={sizes} priority={priority} />;
}

function ProductPhoto({ src, name, category, sizes, priority }: {
  src?: string; name: string; category?: string; sizes: string; priority: boolean;
}) {
  const [attempt, setAttempt] = useState(0);
  const Glyph = glyphs[category as keyof typeof glyphs] ?? Package;
  const retrySrc = src && attempt === 1 ? src + (src.includes("?") ? "&" : "?") + "retry=1" : src;
  return <div className="sf-product-image" data-image-kind={src?.startsWith("/images/products/") ? "cutout" : "photo"}>
    {src && attempt < 2 ? <Image
      key={attempt} src={retrySrc!} alt={name} fill sizes={sizes} preload={priority}
      onError={() => setAttempt(current => Math.min(current + 1, 2))}
    /> : src ? <div className="sf-product-fallback" role="img" aria-label={"Photo temporarily unavailable for " + name}>
      <ImageOff size={28} aria-hidden /><small>Photo unavailable</small>
    </div> : <div className="sf-product-fallback" data-testid="designed-image-fallback" role="img" aria-label={name + " - product illustration"}>
      <Glyph size={28} aria-hidden /><span aria-hidden>{name.charAt(0).toUpperCase()}</span>
    </div>}
  </div>;
}
