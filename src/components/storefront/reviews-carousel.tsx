import { RailScroller } from "./rail-scroller";
import { SectionReveal } from "./scroll-motion";
const reviews = [
  ["The names I grew up with, all in one basket. Sunday cooking feels a little closer to home.", "A pantry regular"],
  ["I like choosing my own swaps. The little details make the weekly shop feel personal.", "A neighborhood cook"],
  ["One stop for the soup essentials and something fresh for tonight. That's my kind of shop.", "A family shopper"],
];
export function ReviewsCarousel({ demo }: { demo: boolean }) {
  if (!demo) return null;
  return <SectionReveal className="sf-container sf-review-section"><section data-testid="reviews-carousel">
    <RailScroller className="sf-reviews-rail" label="Sample store reviews" title="Around the table." description="Sample reviews for this demo. These are fictional, not customer testimonials.">
      {reviews.map(([quote, name], i) => <figure key={name} className="sf-review-card"><span aria-hidden className="sf-quote-mark">“</span><blockquote>{quote}</blockquote><figcaption><span aria-hidden>{String(i + 1).padStart(2, "0")}</span><div>{name}<small>Sample review</small></div></figcaption></figure>)}
    </RailScroller>
  </section></SectionReveal>;
}
