"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Home, LayoutGrid, Search, UserRound } from "lucide-react";
import { CartTrigger } from "./cart-provider";
import styles from "./cart.module.css";
const links = [
  { href: "/", label: "Home", icon: Home },
  { href: "/categories", label: "Categories", icon: LayoutGrid },
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
        return (
          <div key={href} className={styles.navSlot}>
            {index === 3 && <CartTrigger className={styles.navCart} />}
            <Link
              href={href}
              aria-label={label}
              aria-current={active ? "page" : undefined}
              className={active ? styles.activeNav : styles.navLink}
            >
              <Icon size={21} />
              <span>{label}</span>
            </Link>
          </div>
        );
      })}
    </nav>
  );
}
