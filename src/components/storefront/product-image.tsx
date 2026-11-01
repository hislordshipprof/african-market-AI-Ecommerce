"use client";
import Image from "next/image";
import { useState } from "react";
import { ImageOff } from "lucide-react";

export function ProductImage({
  src,
  name,
  sizes = "(max-width: 767px) 44vw, 220px",
  priority = false,
}: {
  src?: string;
  name: string;
  sizes?: string;
  priority?: boolean;
}) {
  return (
    <ProductPhoto
      key={src || "missing"}
      src={src}
      name={name}
      sizes={sizes}
      priority={priority}
    />
  );
}

function ProductPhoto({
  src,
  name,
  sizes,
  priority,
}: {
  src?: string;
  name: string;
  sizes: string;
  priority: boolean;
}) {
  const [failed, setFailed] = useState(false);
  return (
    <div className="sf-product-image">
      {src && !failed ? (
        <Image
          src={src}
          alt={name}
          fill
          sizes={sizes}
          preload={priority}
          className="object-contain"
          onError={() => setFailed(true)}
        />
      ) : src ? (
        <div className="sf-product-fallback" role="img" aria-label={`Photo temporarily unavailable for ${name}`}><ImageOff size={28} aria-hidden /><small>Photo unavailable</small></div>
      ) : (
        <div
          className="sf-product-fallback"
          role="img"
          aria-label={`Photo coming soon for ${name}`}
        >
          <span aria-hidden>{name.charAt(0).toUpperCase()}</span>
          <small>Photo coming soon</small>
        </div>
      )}
    </div>
  );
}
