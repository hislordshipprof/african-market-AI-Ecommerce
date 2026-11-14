import styles from "@/components/directory/directory.module.css";

/** A state or city with no listed store (#451). */
export default function DirectoryNotFound() {
  return (
    <div className={styles.page}>
      <header className={styles.bar}>
        <a href="/" className={styles.wordmark}>African Markets</a>
      </header>
      <main className={styles.main}>
        <section className={styles.intro}>
          <h1 className={styles.title}>No stores listed here yet</h1>
          <p className={styles.lede}>
            <a href="/" className={styles.stateStore}>Search all stores</a> by ZIP code or city to find the nearest one.
          </p>
        </section>
      </main>
    </div>
  );
}
