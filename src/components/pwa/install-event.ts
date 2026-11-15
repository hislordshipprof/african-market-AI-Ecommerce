/**
 * Chrome may offer its install prompt before the prompt's code has loaded (it loads after the first paint),
 * so the event is held here until the prompt takes it.
 */
let held: Event | null = null;

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", event => {
    event.preventDefault();
    held = event;
  });
}

export function takeHeldInstallEvent(): Event | null {
  const event = held;
  held = null;
  return event;
}
