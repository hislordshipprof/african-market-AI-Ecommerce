"use client";
import { useRef } from "react";
import Link from "next/link";
import Image from "next/image";
import { m, useReducedMotion, useScroll, useTransform } from "motion/react";

const names = ["Egusi", "Garri", "Ogbono", "Suya spice", "Ata rodo", "Fufu flour"];
const photos = ["yam-white-puna", "cassava-root-fresh", "egusi-seeds-whole"];

export function MarketMarquee() {
  const ref = useRef<HTMLElement>(null);
  const reduced = useReducedMotion();
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start end", "end start"] });
  const x = useTransform(scrollYProgress, [0, 1], [64, 0]);
  return <section ref={ref} className="sf-market-band" data-testid="market-band" aria-label="Familiar names from home">
    <div className="sf-market-window">
      <m.div className="sf-market-track" style={{ x: reduced ? 0 : x }}>
        {names.map((name, i) => <span className="sf-market-item" key={name}>
          <Link className="sf-market-chip" href={"/search?q=" + encodeURIComponent(name.toLowerCase())}>{name}</Link>
          <Image src={"/images/products/" + photos[i % photos.length] + ".webp"} width={52} height={52} alt="" />
        </span>)}
      </m.div>
    </div>
  </section>;
}
