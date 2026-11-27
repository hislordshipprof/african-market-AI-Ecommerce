import Link from "next/link";
import { DirectoryFooter } from "@/components/directory/directory-footer";
import styles from "@/components/directory/directory.module.css";

/** A state or city with no listed store (#451). */
export default function DirectoryNotFound() {
  return (
    <div className={styles.page}>
      <header className={styles.bar}>
        <Link href="/" className={styles.wordmark}>Globe Grocer</Link>
      </header>
      <main className={styles.main}>
        <section className={styles.intro}>
          <h1 className={styles.title}>No stores listed here yet</h1>
          <p className={styles.lede}>
            <Link href="/" className={styles.stateStore}>Search all stores</Link> by ZIP code or city to find the nearest one.
          </p>
        </section>
      </main>
      <DirectoryFooter />
    </div>
  );
}
