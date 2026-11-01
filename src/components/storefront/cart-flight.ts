/** Decorative only: cart updates never depend on animation. */
export function flyToCart(origin: HTMLElement) {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const source = origin.closest(".sf-product-card, .sf-quick-view, .sf-detail, li")?.querySelector("img");
  const target = document.querySelector<HTMLElement>(".sf-header-cart");
  if (!(source instanceof HTMLImageElement) || !target || !source.complete) return;
  const from = source.getBoundingClientRect(), to = target.getBoundingClientRect();
  const flight = source.cloneNode() as HTMLImageElement;
  flight.removeAttribute("srcset"); flight.src = source.currentSrc; flight.alt = "";
  flight.setAttribute("aria-hidden", "true"); flight.dataset.testid = "cart-flight";
  Object.assign(flight.style, { position: "fixed", inset: "auto", left: `${from.x + from.width / 2 - 24}px`, top: `${from.y + from.height / 2 - 24}px`, width: "48px", height: "48px", objectFit: "contain", borderRadius: "12px", zIndex: "1000", pointerEvents: "none" });
  (origin.closest("dialog") ?? document.body).append(flight);
  const dx = to.x + to.width / 2 - from.x - from.width / 2;
  const dy = to.y + to.height / 2 - from.y - from.height / 2;
  const animation = flight.animate([{ transform: "translate(0,0) scale(1)", opacity: 1 }, { transform: `translate(${dx * 0.55}px,${dy - 60}px) scale(.8)`, opacity: 1, offset: 0.55 }, { transform: `translate(${dx}px,${dy}px) scale(.2)`, opacity: 0 }], { duration: 620, easing: "cubic-bezier(.2,.7,.2,1)" });
  animation.finished.then(() => { flight.remove(); target.animate([{ transform: "scale(1)" }, { transform: "scale(1.1)" }, { transform: "scale(1)" }], { duration: 280 }); }).catch(() => flight.remove());
}
