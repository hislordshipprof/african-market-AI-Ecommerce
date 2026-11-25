import Link from "next/link";
import styles from "./directory.module.css";

/** The home's state list, which every marketplace page's footer links to (#810). */
export const STATES_ANCHOR = "stores-by-state";

export function DirectoryFooter() {
  return (
    <footer className={styles.footer}>
      <Link href="/" className={styles.wordmark}>African Markets</Link>
      <nav aria-label="Marketplace">
        <ul className={styles.footerLinks}>
          {/* A full load: the home streams behind its loading screen, so a client navigation lands at the top, not on the list. */}
          <li><a href={`/#${STATES_ANCHOR}`}>Stores by state</a></li>
          <li><Link href="/sell">Sell on African Markets</Link></li>
        </ul>
      </nav>
    </footer>
  );
}
