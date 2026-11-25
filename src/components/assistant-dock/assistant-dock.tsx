"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Maximize2, Minimize2, MoreHorizontal, SquarePen, Sparkles, X } from "lucide-react";
import { dockOpenRequested, launcherLift, withoutDockParam } from "@/lib/assistant/ui/dock";
import { assistantHiddenForStore, hideAssistantForStore } from "@/lib/assistant/ui/session-hide";
import styles from "./dock.module.css";

/** Bars fixed or stuck to the bottom of a page carry this attribute; the button rises above them. */
export const DOCK_AVOID = "data-assistant-avoid";

/** An open Base UI or Radix dialog from the page (both portal to <body>, outside the sheet). */
const FOREIGN_DIALOG = ['[role="dialog"]', '[role="alertdialog"]'].flatMap((role) => [`${role}[data-open]`, `${role}[data-state="open"]`]).join(", ");

/**
 * The floating assistant button and its chat sheet, for the platform admin and the store admin (#855).
 * Mounted in the area's layout, so the chat, the open state and the draft survive moving between pages.
 * The sheet is a modal <dialog>: role, label, focus trap and Esc come from the browser.
 */
export function AssistantDock({
  title,
  hideKey,
  hiddenOn,
  menu = [],
  newChat,
  onFirstOpen,
  children,
}: {
  title: string;
  /** The launcher can be hidden until the next full page load, as on the storefront. */
  hideKey: string;
  /** Paths where the button stays away (sign-in and 2FA set-up). */
  hiddenOn?: (pathname: string) => boolean;
  menu?: Array<{ href: string; label: string }>;
  newChat: { onClick: () => void; disabled: boolean };
  onFirstOpen: () => void;
  children: ReactNode;
}) {
  const pathname = usePathname() || "/";
  const searchParams = useSearchParams();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [hidden, setHidden] = useState(() => assistantHiddenForStore(hideKey));
  const [menuOpen, setMenuOpen] = useState(false);
  const [lift, setLift] = useState(0);
  const launcher = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const menuWrap = useRef<HTMLDivElement>(null);
  const loaded = useRef(false);

  function show() {
    setMounted(true);
    setOpen(true);
  }

  // `?assistant=open` (the old /admin/assistant link) opens the sheet, then leaves the URL clean.
  const search = searchParams?.toString() ?? "";
  const requested = dockOpenRequested(search);
  const [handled, setHandled] = useState<string | null>(null);
  if (requested && handled !== search) {
    setHandled(search);
    show();
  }
  useEffect(() => {
    if (requested) router.replace(withoutDockParam(pathname, search), { scroll: false });
  }, [requested, search, pathname, router]);

  // The chat loads the first time the sheet opens, not on every page load.
  useEffect(() => {
    if (!open || loaded.current) return;
    loaded.current = true;
    onFirstOpen();
  }, [open, onFirstOpen]);

  useEffect(() => {
    const node = dialog.current;
    if (!node || !open) return;
    if (node.open) {
      delete node.dataset.closing;
      return;
    }
    node.showModal();
  }, [open, mounted]);

  // A link in the sheet can open a page that shows its own dialog (Edit listing). That dialog hides the rest of
  // the page from input, the sheet included, so the sheet steps aside and leaves focus with it.
  const steppedAside = useRef(false);
  useEffect(() => {
    if (!open) return;
    const check = () => {
      const foreign = Array.from(document.querySelectorAll(FOREIGN_DIALOG))
        .some((element) => !dialog.current?.contains(element));
      if (!foreign) return;
      steppedAside.current = true;
      setOpen(false);
    };
    const observer = new MutationObserver(check);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-open", "data-state"] });
    return () => observer.disconnect();
  }, [open]);

  useEffect(() => {
    const node = dialog.current;
    if (!node || open || !node.open) return;
    node.dataset.closing = "true";
    const timeout = window.setTimeout(
      () => {
        node.close();
        delete node.dataset.closing;
        if (!steppedAside.current) launcher.current?.focus();
        steppedAside.current = false;
      },
      window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 200,
    );
    return () => window.clearTimeout(timeout);
  }, [open]);

  // The menu floats over the sheet: a tap or focus elsewhere closes it, and Esc closes it before the sheet.
  useEffect(() => {
    if (!menuOpen) return;
    const dismiss = (event: Event) => {
      if (event.target instanceof Node && menuWrap.current?.contains(event.target)) return;
      setMenuOpen(false);
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setMenuOpen(false);
      menuWrap.current?.querySelector("button")?.focus();
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("focusin", dismiss);
    document.addEventListener("keydown", onEscape, true);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("focusin", dismiss);
      document.removeEventListener("keydown", onEscape, true);
    };
  }, [menuOpen]);

  // A page's bottom bar (packing, CSV import) keeps its buttons: the launcher rises above it.
  useEffect(() => {
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const bars = Array.from(document.querySelectorAll(`[${DOCK_AVOID}]`), (bar) => bar.getBoundingClientRect());
        setLift(launcherLift(bars, window.innerHeight));
      });
    };
    measure();
    window.addEventListener("scroll", measure, { passive: true });
    window.addEventListener("resize", measure);
    const observer = new MutationObserver(measure);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
      observer.disconnect();
    };
  }, [pathname]);

  const away = hidden || (hiddenOn?.(pathname) ?? false);

  return (
    <>
      {away ? null : (
        <button
          ref={launcher}
          type="button"
          className={styles.launcher}
          style={lift ? { ["--dock-lift" as string]: `${lift + 8}px` } : undefined}
          data-testid="assistant-launcher"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={show}
        >
          <Sparkles size={18} aria-hidden="true" />
          {title}
        </button>
      )}
      {mounted ? (
        <dialog
          ref={dialog}
          className={styles.sheet}
          aria-label={title}
          data-testid="assistant-sheet"
          data-expanded={expanded}
          onCancel={(event) => {
            event.preventDefault();
            setOpen(false);
          }}
          onClick={(event) => {
            if (event.target === event.currentTarget) setOpen(false);
          }}
        >
          <div className={styles.inner}>
            <header className={styles.header}>
              <h2>{title}</h2>
              <button type="button" className={styles.textButton} disabled={newChat.disabled} onClick={newChat.onClick}>
                <SquarePen size={16} aria-hidden="true" />
                New chat
              </button>
              <div ref={menuWrap} className={styles.menuWrap}>
                <button
                  type="button"
                  className={styles.iconButton}
                  aria-label="More"
                  aria-haspopup="true"
                  aria-expanded={menuOpen}
                  onClick={() => setMenuOpen((value) => !value)}
                >
                  <MoreHorizontal size={20} aria-hidden="true" />
                </button>
                {menuOpen ? (
                  <div className={styles.menu}>
                    {menu.map((item) => (
                      <Link key={item.href} href={item.href} onClick={() => setMenuOpen(false)}>
                        {item.label}
                      </Link>
                    ))}
                    <button
                      type="button"
                      onClick={() => {
                        hideAssistantForStore(hideKey);
                        setHidden(true);
                        setMenuOpen(false);
                        setOpen(false);
                      }}
                    >
                      Hide the button until I reload
                    </button>
                  </div>
                ) : null}
              </div>
              <button
                type="button"
                className={`${styles.iconButton} ${styles.expand}`}
                aria-label={expanded ? "Narrow the panel" : "Widen the panel"}
                aria-pressed={expanded}
                onClick={() => setExpanded((value) => !value)}
              >
                {expanded ? <Minimize2 size={18} aria-hidden="true" /> : <Maximize2 size={18} aria-hidden="true" />}
              </button>
              <button type="button" className={styles.iconButton} aria-label={`Close ${title}`} onClick={() => setOpen(false)}>
                <X size={22} aria-hidden="true" />
              </button>
            </header>
            <div className={styles.body}>{children}</div>
          </div>
        </dialog>
      ) : null}
    </>
  );
}
