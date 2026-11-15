"use client";

import { useActionState, useEffect, useId, useRef, useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Info } from "lucide-react";
import type { MasterProductEditor } from "@/lib/admin/master-catalog";
import { addProductSynonym, removeProductSynonym, updateProductSynonym, type SynonymState } from "@/lib/admin/product-synonyms";
import { SYNONYM_LANGUAGES, languageLabel, type SynonymField } from "@/lib/admin/catalog-structure-form";

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
const FIELD = `min-h-11 w-full rounded-lg border border-input bg-background px-3 text-base text-foreground aria-[invalid=true]:border-destructive ${FOCUS}`;
const QUIET_BUTTON = `inline-flex min-h-11 items-center rounded-full border border-input px-4 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-60 ${FOCUS}`;

type Synonym = MasterProductEditor["synonyms"][number];

export function Synonyms({ productId, synonyms }: { productId: string; synonyms: Synonym[] }) {
  return (
    <div className="mt-4 grid gap-5">
      {synonyms.length === 0 ? (
        <p className="text-sm text-muted-foreground">No local names or synonyms yet. Add the names shoppers search for.</p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border" aria-label="Local names and synonyms">
          {synonyms.map((synonym) => (
            <SynonymRow key={synonym.id} productId={productId} synonym={synonym} />
          ))}
        </ul>
      )}
      <SynonymForm productId={productId} />
    </div>
  );
}

function SynonymRow({ productId, synonym }: { productId: string; synonym: Synonym }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [removeState, remove, removing] = useActionState<SynonymState, FormData>(removeProductSynonym, {});

  useEffect(() => {
    if (removeState.ok) router.refresh();
  }, [removeState, router]);

  const details = [languageLabel(synonym.language) ?? "No language", synonym.region].filter(Boolean).join(", ");

  return (
    <li className="grid gap-3 px-3 py-3 sm:px-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="break-words font-medium text-foreground" lang={synonym.language && /^[a-z]{2,3}$/.test(synonym.language) ? synonym.language : undefined}>
            {synonym.term}
          </p>
          <p className="text-sm text-muted-foreground">{details}</p>
          {synonym.alsoNames.length > 0 && (
            <p className="mt-1 flex items-start gap-1.5 text-sm text-foreground">
              <Info aria-hidden className="mt-0.5 size-4 shrink-0" />
              <span>Also names {synonym.alsoNames.join(", ")}</span>
            </p>
          )}
        </div>
        <div className="flex shrink-0 gap-2">
          <button type="button" aria-expanded={editing} onClick={() => setEditing((open) => !open)} className={QUIET_BUTTON}>
            {editing ? "Close" : "Edit"}
            <span className="sr-only"> {synonym.term}</span>
          </button>
          <form action={remove}>
            <input type="hidden" name="productId" value={productId} />
            <input type="hidden" name="synonymId" value={synonym.id} />
            <button type="submit" disabled={removing} className={QUIET_BUTTON}>
              {removing ? "Removing…" : "Remove"}
              <span className="sr-only"> {synonym.term}</span>
            </button>
          </form>
        </div>
      </div>
      {removeState.ok === false && <p role="alert" className="text-sm text-destructive">{removeState.message}</p>}
      {editing && <SynonymForm productId={productId} synonym={synonym} onSaved={() => setEditing(false)} />}
    </li>
  );
}

/** The listed code for a stored language; an older seeded label such as "Yoruba" maps to its code when it can. */
function languageDefaults(language: string | null): { select: string; other: string } {
  if (!language) return { select: "", other: "" };
  const listed = SYNONYM_LANGUAGES.find(([code, name]) => code === language || name.toLowerCase() === language.toLowerCase());
  return listed ? { select: listed[0], other: "" } : { select: "other", other: language };
}

function SynonymForm({ productId, synonym, onSaved }: { productId: string; synonym?: Synonym; onSaved?: () => void }) {
  const router = useRouter();
  const prefix = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const [state, action, saving] = useActionState<SynonymState, FormData>(synonym ? updateProductSynonym : addProductSynonym, {});
  const [, startTransition] = useTransition();
  const defaults = languageDefaults(synonym?.language ?? null);
  const [language, setLanguage] = useState(defaults.select);

  useEffect(() => {
    if (state.ok) {
      if (!synonym) formRef.current?.reset();
      router.refresh();
      if (synonym && !state.alsoNames?.length) onSaved?.();
    } else formRef.current?.querySelector<HTMLElement>("[aria-invalid='true']")?.focus();
  }, [state, router, synonym, onSaved]);

  // Submitting through a transition keeps what the admin typed when a field is refused.
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    startTransition(() => action(form));
  }

  const id = (field: string) => `${prefix}-${field}`;
  const error = (field: SynonymField) => state.fieldErrors?.[field];
  const described = (field: SynonymField) => (error(field) ? { "aria-invalid": true, "aria-describedby": id(`${field}-error`) } : {});

  return (
    <form
      ref={formRef}
      onSubmit={submit}
      onReset={() => setLanguage(defaults.select)}
      noValidate
      autoComplete="off"
      aria-label={synonym ? `Edit ${synonym.term}` : "Add a local name or synonym"}
      className={synonym ? "grid gap-3 rounded-lg bg-muted/50 p-3" : "grid gap-3"}
    >
      {!synonym && <h3 className="text-base font-semibold text-foreground">Add a term</h3>}
      <input type="hidden" name="productId" value={productId} />
      {synonym && <input type="hidden" name="synonymId" value={synonym.id} />}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id={id("term")} label="Term" error={error("term")}>
          <input id={id("term")} name="term" defaultValue={synonym?.term ?? ""} maxLength={100} spellCheck={false} className={FIELD} {...described("term")} />
        </Field>
        <Field id={id("region")} label="Region" hint="Optional, such as Ghana or Lagos" error={error("region")}>
          <input id={id("region")} name="region" defaultValue={synonym?.region ?? ""} maxLength={60} className={FIELD} {...described("region")} />
        </Field>
        <Field id={id("language")} label="Language" error={language === "other" ? undefined : error("language")}>
          <select
            id={id("language")}
            name="language"
            value={language}
            onChange={(event) => setLanguage(event.target.value)}
            className={FIELD}
            {...(language === "other" ? {} : described("language"))}
          >
            <option value="">No language (a spelling or search term)</option>
            {SYNONYM_LANGUAGES.map(([code, name]) => (
              <option key={code} value={code}>{name} ({code})</option>
            ))}
            <option value="other">Another language…</option>
          </select>
        </Field>
        {language === "other" && (
          <Field id={id("languageOther")} label="ISO 639 code" hint="Two or three letters, such as bm for Bambara" error={error("language")}>
            <input
              id={id("languageOther")}
              name="languageOther"
              defaultValue={defaults.other}
              maxLength={20}
              spellCheck={false}
              className={`${FIELD} sm:max-w-40`}
              {...(error("language") ? { "aria-invalid": true, "aria-describedby": id("languageOther-error") } : {})}
            />
          </Field>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={saving}
          className={`inline-flex min-h-11 items-center rounded-full bg-primary px-5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60 ${FOCUS}`}
        >
          {saving ? "Saving…" : synonym ? "Save term" : "Add term"}
        </button>
        <p role="status" className={`flex items-start gap-1.5 text-sm ${state.ok === false ? "text-destructive" : "text-foreground"}`}>
          {!saving && state.alsoNames && state.alsoNames.length > 0 && <Info aria-hidden className="mt-0.5 size-4 shrink-0" />}
          {saving ? "" : state.message ?? ""}
        </p>
      </div>
    </form>
  );
}

function Field({ id, label, hint, error, children }: { id: string; label: string; hint?: string; error?: string; children: React.ReactNode }) {
  return (
    <div className="grid content-start gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-foreground">{label}</label>
      {children}
      {hint && !error && <p className="text-sm text-muted-foreground">{hint}</p>}
      {error && <p id={`${id}-error`} className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
