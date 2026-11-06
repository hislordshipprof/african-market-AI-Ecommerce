const SECRET_KEYS = new Set([
  "checkoutToken",
  "clientSecret",
  "client_secret",
  "paymentMethodId",
  "savedPaymentMethodId",
  "savedCardRef",
  "contactName",
  "contactEmail",
  "contactPhone",
  "contact",
  "email",
  "phone",
]);

/** Drops payment secrets and contact fields before a tool result is stored or shown to the model. */
export function projectCheckoutSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => projectCheckoutSecrets(item));
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEYS.has(key)) continue;
    out[key] = projectCheckoutSecrets(child);
  }
  return out;
}

export function checkoutModelOutput(output: unknown): unknown {
  const projected = projectCheckoutSecrets(output);
  if (!projected || typeof projected !== "object" || Array.isArray(projected)) return projected;
  const record = projected as Record<string, unknown>;
  return {
    ok: record.ok === true,
    kind: record.kind ?? null,
    code: record.code ?? null,
    message: typeof record.message === "string" ? record.message : null,
    contactOnFile: record.contactOnFile === true,
    card: record.card ?? null,
    addressOnFile: record.addressOnFile === true,
    holdCents: typeof record.holdCents === "number" ? record.holdCents : null,
  };
}
