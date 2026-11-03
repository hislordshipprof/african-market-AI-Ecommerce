// US +1 NANP phone validation and normalization (E1)

const DIGITS_RE = /\D/g;

const PREMIUM_NPAS = new Set(["900"]);
const UNASSIGNED_NPAS = new Set(["999"]);
const PREMIUM_NXXS = new Set(["976"]);
const N11_CODES = new Set(["211", "311", "411", "511", "611", "711", "811", "911"]);

// Canadian area codes (CRTC, current as of 2025)
const CANADIAN_NPAS = new Set([
  "204","226","236","249","250","263","289","306","343","354","365","367",
  "368","382","387","403","416","418","428","431","437","438","450","468",
  "474","506","514","519","548","579","581","584","587","604","613","639",
  "647","672","683","705","709","742","753","778","780","782","807","819",
  "825","867","873","879","902","905","942",
]);

// Non-US Caribbean/Atlantic NANP area codes
const NON_US_CARIBBEAN_NPAS = new Set([
  "242","246","264","268","284","345","441","473","649","664",
  "721","758","767","784","809","829","849","868","869","876",
]);

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
  if (UNASSIGNED_NPAS.has(npa)) return null;
  if (PREMIUM_NXXS.has(nxx)) return null;
  if (N11_CODES.has(npa)) return null;
  if (CANADIAN_NPAS.has(npa)) return null;
  if (NON_US_CARIBBEAN_NPAS.has(npa)) return null;

  return `+1${nationalDigits}`;
}

export function isValidUsPhone(raw: string): boolean {
  return normalizePhone(raw) !== null;
}
