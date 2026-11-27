import Link from "next/link";
import styles from "./directory.module.css";

/** The home's state list, which every marketplace page's footer links to (#810). */
export const STATES_ANCHOR = "stores-by-state";

export function DirectoryFooter() {
  return (
    <footer className={styles.footer}>
      <Link href="/" className={styles.wordmark}>Globe Grocer</Link>
      <nav aria-label="Marketplace">
        <ul className={styles.footerLinks}>
          {/* A full load: a client navigation from a state page landed at the top of the home, not on the list. */}
          <li><a href={`/#${STATES_ANCHOR}`}>Stores by state</a></li>
          <li><Link href="/sell">Sell on Globe Grocer</Link></li>
        </ul>
      </nav>
    </footer>
  );
}
