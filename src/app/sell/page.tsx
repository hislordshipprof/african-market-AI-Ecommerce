import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import directory from "@/components/directory/directory.module.css";
import { PlanComparison } from "@/components/billing/plan-comparison";
import { pilotOffer } from "@/lib/billing/service";
import { SELL_STEPS } from "@/lib/store-application/steps";
import { SellForm } from "./sell-form";
import styles from "./sell.module.css";

export const metadata = { title: "Sell on Globe Grocer" };

export default async function SellPage() {
  // The application form lives on the root domain only; a store's own site has no /sell (#554).
  if ((await headers()).get("x-platform-root") !== "1") notFound();
  const offer = await pilotOffer();

  return (
    <div className={directory.page}>
      <header className={styles.bar}>
        <Link href="/" className={directory.wordmark}>Globe Grocer</Link>
      </header>
      <main className={`${directory.main} ${styles.layout}`}>
        <section aria-labelledby="sell-title">
          <h1 id="sell-title" className={directory.title}>Sell on Globe Grocer</h1>
          <p className={directory.lede}>
            Your own online shop under your store&apos;s name, for pickup and delivery. No commission on your sales.
          </p>
          <ol className={styles.steps}>
            {SELL_STEPS.map((step, index) => (
              <li key={step.title} className={styles.step}>
                <span className={styles.stepNumber} aria-hidden="true">{index + 1}</span>
                <span>
                  <span className={styles.stepTitle}>{step.title}</span>
                  <span className={styles.stepBody}>{step.body}</span>
                </span>
              </li>
            ))}
          </ol>
          <div className={styles.plans}>
            <PlanComparison offer={offer} />
          </div>
        </section>
        <SellForm />
      </main>
    </div>
  );
}
