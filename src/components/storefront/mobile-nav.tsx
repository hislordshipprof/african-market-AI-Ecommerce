"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Home, LayoutGrid, Search, UserRound } from "lucide-react";
import { CartTrigger } from "./cart-provider";
import styles from "./cart.module.css";
import { AislesOpener } from "./aisle-menu";
const links = [
  { href: "/", label: "Home", icon: Home },
  { href: "/categories", label: "Aisles", icon: LayoutGrid },
  { href: "/search", label: "Search", icon: Search },
  { href: "/account", label: "Account", icon: UserRound },
];
export function MobileNav() {
  const pathname = usePathname();
  return (
    <nav className={styles.mobileNav} aria-label="Main navigation">
      {links.map(({ href, label, icon: Icon }, index) => {
        const active =
          href === "/"
            ? pathname === href
            : pathname === href || pathname.startsWith(`${href}/`);
        const className = active ? styles.activeNav : styles.navLink;
        return (
          <div key={href} className={styles.navSlot}>
            {index === 3 && <CartTrigger className={styles.navCart} />}
            {/* The Aisles tab opens the aisle tree as a sheet (#862) instead of leaving the page. */}
            {href === "/categories" ? (
              <AislesOpener className={className} aria-label={label} aria-current={active ? "page" : undefined}>
                <Icon size={21} />
                <span>{label}</span>
              </AislesOpener>
            ) : <Link
              href={href}
              aria-label={label}
              aria-current={active ? "page" : undefined}
              className={className}
            >
              <Icon size={21} />
              <span>{label}</span>
            </Link>}
          </div>
        );
      })}
    </nav>
  );
}
