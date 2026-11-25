"use client";

import { useActionState, useEffect, useRef } from "react";
import Link from "next/link";
import { CircleAlert } from "lucide-react";
import { submitStoreApplicationAction, type SellFormState } from "@/lib/store-application/actions";
import { PLAN_CHOICES, STORE_TYPES } from "@/lib/store-application/fields";
import { USPS_STATE_CODES } from "@/lib/customer-account/address-validation";
import styles from "./sell.module.css";

const INITIAL: SellFormState = { status: "idle" };

export function SellForm() {
  const [state, action, pending] = useActionState(submitStoreApplicationAction, INITIAL);
  const formRef = useRef<HTMLFormElement>(null);
  const summaryRef = useRef<HTMLParagraphElement>(null);

  // After a rejected submit, focus goes to the first flagged field, or to the summary when no field is flagged (#728).
  useEffect(() => {
    if (state.status !== "error") return;
    const flagged = formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]');
    // A flagged radio group takes focus on its first option.
    const first = flagged?.getAttribute("role") === "radiogroup" ? flagged.querySelector<HTMLElement>("input") : flagged;
    (first ?? summaryRef.current)?.focus();
  }, [state]);

  if (state.status === "sent") {
    return (
      <section className={styles.card} aria-live="polite">
        <h2 className={styles.doneTitle}>Thanks, we have your application</h2>
        <p className={styles.doneBody}>
          We review every store by hand and reply by email. If we approve it, the email has a link to set up your shop.
        </p>
        <Link href="/" className={styles.back}>Return to directory</Link>
      </section>
    );
  }

  const errors = state.status === "error" ? state.fieldErrors : {};
  const values = state.status === "error" ? state.values : {};
  // A new key after each failed try remounts the fields, so they show what was sent.
  const formKey = state.status === "error" ? JSON.stringify(values) : "fresh";

  return (
    <form ref={formRef} action={action} className={styles.card} aria-labelledby="sell-form-title" key={formKey}>
      <h2 id="sell-form-title" className={styles.formTitle}>Your store</h2>
      {state.status === "error" && (
        <p role="alert" className={styles.formError} ref={summaryRef} tabIndex={-1}>
          <CircleAlert aria-hidden="true" size={18} className={styles.errorIcon} />
          {state.message}
        </p>
      )}

      <Field name="businessName" label="Store name" error={errors.businessName} defaultValue={values.businessName} autoComplete="organization" maxLength={120} />

      <div className={styles.field}>
        <label htmlFor="storeType" className={styles.label}>Kind of store</label>
        <select
          id="storeType"
          name="storeType"
          required
          defaultValue={values.storeType ?? ""}
          aria-invalid={errors.storeType ? true : undefined}
          aria-describedby={errors.storeType ? "storeType-error" : undefined}
          className={styles.input}
        >
          <option value="" disabled>Choose one</option>
          {STORE_TYPES.map((type) => (
            <option key={type.value} value={type.value}>{type.label}</option>
          ))}
        </select>
        {errors.storeType && <FieldError id="storeType-error" text={errors.storeType} />}
      </div>

      <Field name="addressLine1" label="Street address" error={errors.addressLine1} defaultValue={values.addressLine1} autoComplete="address-line1" maxLength={100} />
      <div className={styles.row}>
        <Field name="city" label="City" error={errors.city} defaultValue={values.city} autoComplete="address-level2" maxLength={60} />
        <div className={styles.field}>
          <label htmlFor="state" className={styles.label}>State</label>
          <select
            id="state"
            name="state"
            required
            defaultValue={values.state ?? ""}
            autoComplete="address-level1"
            aria-invalid={errors.state ? true : undefined}
            aria-describedby={errors.state ? "state-error" : undefined}
            className={styles.input}
          >
            <option value="" disabled>State</option>
            {USPS_STATE_CODES.map((code) => (
              <option key={code} value={code}>{code}</option>
            ))}
          </select>
          {errors.state && <FieldError id="state-error" text={errors.state} />}
        </div>
        <Field name="zip" label="ZIP" error={errors.zip} defaultValue={values.zip} autoComplete="postal-code" inputMode="numeric" maxLength={5} />
      </div>

      <h2 className={styles.formTitle}>About you</h2>
      <Field name="ownerName" label="Your name" error={errors.ownerName} defaultValue={values.ownerName} autoComplete="name" maxLength={120} />
      <div className={styles.row2}>
        <Field name="email" label="Email" type="email" error={errors.email} defaultValue={values.email} autoComplete="email" maxLength={254} />
        <Field name="phone" label="Phone" type="tel" error={errors.phone} defaultValue={values.phone} autoComplete="tel" maxLength={40} />
      </div>
      <Field
        name="website"
        label="Website or social page"
        hint="Optional. A link to your site, Instagram, Facebook or Google listing."
        required={false}
        error={errors.website}
        defaultValue={values.website}
        autoComplete="url"
        maxLength={300}
      />

      <fieldset className={styles.fieldset}>
        <legend className={styles.label}>What do you offer today?</legend>
        <label className={styles.check}>
          <input type="checkbox" name="offersPickup" defaultChecked={values.offersPickup === "on"} />
          Pickup at the store
        </label>
        <label className={styles.check}>
          <input type="checkbox" name="offersDelivery" defaultChecked={values.offersDelivery === "on"} />
          Delivery
        </label>
      </fieldset>

      <fieldset
        className={styles.fieldset}
        role="radiogroup"
        aria-labelledby="planChoice-legend"
        aria-describedby={errors.planChoice ? "planChoice-hint planChoice-error" : "planChoice-hint"}
        aria-invalid={errors.planChoice ? true : undefined}
      >
        <legend id="planChoice-legend" className={styles.label}>Which plan are you interested in?</legend>
        <p id="planChoice-hint" className={styles.hint}>
          You choose and pay only after we approve your store. <a href="#plans" className={styles.inlineLink}>Compare the plans</a>
        </p>
        {PLAN_CHOICES.map((choice) => (
          <label key={choice.value} className={styles.check}>
            <input
              type="radio"
              name="planChoice"
              value={choice.value}
              required
              defaultChecked={values.planChoice === choice.value}
            />
            {choice.label}
          </label>
        ))}
        {errors.planChoice && <FieldError id="planChoice-error" text={errors.planChoice} />}
      </fieldset>

      {/* Honeypot: people never see or reach it, so only a bot fills it in. */}
      <div className={styles.trap} aria-hidden="true">
        <label htmlFor="fax">Fax</label>
        <input id="fax" name="fax" type="text" tabIndex={-1} autoComplete="off" />
      </div>

      <button type="submit" className={styles.submit} disabled={pending}>
        {pending ? "Sending…" : "Send application"}
      </button>
      <p className={styles.fine}>We only use these details to review your application and contact you about it.</p>
    </form>
  );
}

function Field({
  name,
  label,
  hint,
  error,
  required = true,
  type = "text",
  ...input
}: {
  name: string;
  label: string;
  hint?: string;
  error?: string;
  required?: boolean;
  type?: string;
  defaultValue?: string;
  autoComplete?: string;
  maxLength?: number;
  inputMode?: "numeric";
}) {
  const described = [hint ? `${name}-hint` : null, error ? `${name}-error` : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className={styles.field}>
      <label htmlFor={name} className={styles.label}>{label}</label>
      {hint && <p id={`${name}-hint`} className={styles.hint}>{hint}</p>}
      <input
        id={name}
        name={name}
        type={type}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={described}
        className={styles.input}
        {...input}
      />
      {error && <FieldError id={`${name}-error`} text={error} />}
    </div>
  );
}

/** Errors carry an icon and text, never colour alone (DESIGN.md, Separate Semantics Rule). */
function FieldError({ id, text }: { id: string; text: string }) {
  return (
    <p id={id} className={styles.error}>
      <CircleAlert aria-hidden="true" size={16} className={styles.errorIcon} />
      {text}
    </p>
  );
}
