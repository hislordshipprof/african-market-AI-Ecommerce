// US +1 NANP phone validation and normalization (E1)

const DIGITS_RE = /\D/g;

const PREMIUM_NPAS = new Set(["900"]);
const PREMIUM_NXXS = new Set(["976"]);
const N11_CODES = new Set(["211", "311", "411", "511", "611", "711", "811", "911"]);

export function normalizePhone(raw: string): string | null {
  const digits = raw.replace(DIGITS_RE, "");

  let nationalDigits: string;
  if (digits.length === 11 && digits.startsWith("1")) {
    nationalDigits = digits.slice(1);
  } else if (digits.length === 10) {
    nationalDigits = digits;
  } else {
    return null;
  }

  const npa = nationalDigits.slice(0, 3);
  const nxx = nationalDigits.slice(3, 6);

  if (npa[0] === "0" || npa[0] === "1") return null;
  if (nxx[0] === "0" || nxx[0] === "1") return null;

  if (PREMIUM_NPAS.has(npa)) return null;
  if (PREMIUM_NXXS.has(nxx)) return null;
  if (N11_CODES.has(npa)) return null;

  return `+1${nationalDigits}`;
}

export function isValidUsPhone(raw: string): boolean {
  return normalizePhone(raw) !== null;
}
