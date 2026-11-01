"use client";
import { useState } from "react";
import { Pause, Play, Asterisk } from "lucide-react";
const names = ["Egusi", "Garri", "Ogbono", "Suya spice", "Ata rodo", "Fufu flour"];
export function MarketMarquee() {
  const [paused, setPaused] = useState(false);
  return <section className="sf-marquee" data-testid="market-marquee" aria-label="Familiar names from home" data-paused={paused}>
    <p className="sr-only">{names.join(" · ")}</p>
    {[0, 1].map(row => <div key={row} className="sf-marquee-window" aria-hidden><div className="sf-marquee-track">{[0, 1].map(copy => <span key={copy}>{names.map(name => <span key={name}>{name}<i><Asterisk size={22} /></i></span>)}</span>)}</div></div>)}
    <button className="sf-round-button sf-marquee-pause" aria-label={paused ? "Play product names" : "Pause product names"} aria-pressed={paused} onClick={() => setPaused(v => !v)}>{paused ? <Play size={15} /> : <Pause size={15} />}</button>
  </section>;
}
