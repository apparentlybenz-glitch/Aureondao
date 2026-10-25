// Money is integer cents. Supabase bigint columns are selected with ::text and
// turned into BigInt here, so no balance ever passes through a JS float.
const HUNDRED = BigInt(100);
const ZERO = BigInt(0);
const grouping = new Intl.NumberFormat("en-US");

export function centsFromText(value: string): bigint {
  return BigInt(value);
}

// 123456n -> "1,234.56"; with sign: true, positive values get a "+".
export function formatCents(cents: bigint, { sign = false }: { sign?: boolean } = {}): string {
  const negative = cents < ZERO;
  const abs = negative ? -cents : cents;
  const whole = grouping.format(abs / HUNDRED);
  const fraction = (abs % HUNDRED).toString().padStart(2, "0");
  const prefix = negative ? "-" : sign && cents > ZERO ? "+" : "";
  return `${prefix}${whole}.${fraction}`;
}

// Plain input form without grouping, for the MAX button: 123456n -> "1234.56".
export function centsToInput(cents: bigint): string {
  return `${cents / HUNDRED}.${(cents % HUNDRED).toString().padStart(2, "0")}`;
}

// "12", "12.", "12.3", "12.34" -> cents. Anything else (signs, exponents,
// more than 2 decimals, more than 12 integer digits) -> null.
export function parseAmount(input: string): bigint | null {
  const match = /^(\d{1,12})(?:\.(\d{0,2}))?$/.exec(input.trim());
  if (!match) return null;
  return BigInt(match[1]) * HUNDRED + BigInt((match[2] ?? "").padEnd(2, "0"));
}

export const ZERO_CENTS = ZERO;
