import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import directory from "@/components/directory/directory.module.css";
import { PLAN_NAMES, PLAN_PRICES_USD } from "@/lib/billing/plan";
import { SellForm } from "./sell-form";
import styles from "./sell.module.css";

export const metadata = { title: "Sell on African Markets" };

const PLANS = `Plans are ${PLAN_NAMES.starter} at $${PLAN_PRICES_USD.starter} a month or ${PLAN_NAMES.pro} at $${PLAN_PRICES_USD.pro} a month.`;

const STEPS = [
  { title: "Apply", body: "Tell us about your store. It takes about three minutes." },
  { title: "We review it", body: "Our team checks every application and replies by email." },
  { title: "Set up and open", body: "Once approved, you get an invite to set up your shop, add products and connect payouts." },
];

export default async function SellPage() {
  // The application form lives on the root domain only; a store's own site has no /sell (#554).
  if ((await headers()).get("x-platform-root") !== "1") notFound();

  return (
    <div className={directory.page}>
      <header className={styles.bar}>
        <Link href="/" className={directory.wordmark}>African Markets</Link>
      </header>
      <main className={`${directory.main} ${styles.layout}`}>
        <section className={styles.intro} aria-labelledby="sell-title">
          <h1 id="sell-title" className={directory.title}>Sell on African Markets</h1>
          <p className={directory.lede}>
            Your own online shop under your store&apos;s name, for pickup and delivery. No commission on your sales.{" "}
            {PLANS}
          </p>
          <ol className={styles.steps}>
            {STEPS.map((step, index) => (
              <li key={step.title} className={styles.step}>
                <span className={styles.stepNumber} aria-hidden="true">{index + 1}</span>
                <span>
                  <span className={styles.stepTitle}>{step.title}</span>
                  <span className={styles.stepBody}>{step.body}</span>
                </span>
              </li>
            ))}
          </ol>
        </section>
        <SellForm />
      </main>
    </div>
  );
}
