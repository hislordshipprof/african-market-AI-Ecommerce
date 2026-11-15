"use client";
import { useRef } from "react";
import Link from "next/link";
import Image from "next/image";
import { useReducedMotion } from "./use-reduced-motion";
import { useScrollProgress } from "./scroll-motion";

const names = ["Egusi", "Garri", "Ogbono", "Suya spice", "Ata rodo", "Fufu flour"];
const photos = ["yam-white-puna", "cassava-root-fresh", "egusi-seeds-whole"];

export function MarketMarquee() {
  const ref = useRef<HTMLElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  useScrollProgress(ref, progress => {
    if (track.current) track.current.style.transform = `translateX(${64 - 64 * progress}px)`;
  }, !reduced);
  return <section ref={ref} className="sf-market-band" data-testid="market-band" aria-label="Familiar names from home">
    <div className="sf-market-window">
      <div ref={track} className="sf-market-track" style={{ transform: "translateX(64px)" }}>
        {names.map((name, i) => <span className="sf-market-item" key={name}>
          <Link className="sf-market-chip" href={"/search?q=" + encodeURIComponent(name.toLowerCase())}>{name}</Link>
          <Image src={"/images/products/" + photos[i % photos.length] + ".webp"} width={52} height={52} alt="" />
        </span>)}
      </div>
    </div>
  </section>;
}
