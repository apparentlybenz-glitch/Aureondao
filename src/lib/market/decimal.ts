// Decimal-string math for display. Prices never pass through a float.
const ZERO = BigInt(0);
const ONE = BigInt(1);
const grouping = new Intl.NumberFormat("en-US");

const DECIMAL = /^(-?)(\d+)(?:\.(\d+))?$/;

export function isDecimal(value: unknown): value is string {
  return typeof value === "string" && DECIMAL.test(value);
}

export function isPositiveDecimal(value: unknown): value is string {
  return isDecimal(value) && /[1-9]/.test(value);
}

// Rounds half up to `decimals` places: ("80163.80000000", 2) -> "80163.80".
// Returns null for anything that is not a plain decimal (exponents, blanks).
export function roundDecimal(value: string, decimals: number): string | null {
  const match = DECIMAL.exec(value);
  if (!match) return null;
  const sign = match[1];
  const whole = match[2];
  const fraction = match[3] ?? "";
  const kept = BigInt(whole + fraction.padEnd(decimals, "0").slice(0, decimals));
  const roundUp = fraction.length > decimals && fraction.charCodeAt(decimals) >= 53; // "5"
  const scaled = (kept + (roundUp ? ONE : ZERO)).toString().padStart(decimals + 1, "0");
  const intPart = scaled.slice(0, scaled.length - decimals);
  const fracPart = scaled.slice(scaled.length - decimals);
  const isZero = !/[1-9]/.test(scaled);
  const text = decimals > 0 ? `${intPart}.${fracPart}` : intPart;
  return isZero || sign === "" ? text : `-${text}`;
}

// 80163.8, 2 -> "80,163.80". "--" when the value is not a plain decimal.
export function formatPrice(value: string, decimals: number): string {
  const rounded = roundDecimal(value, decimals);
  if (rounded === null) return "--";
  const negative = rounded.startsWith("-");
  const [whole, fraction] = (negative ? rounded.slice(1) : rounded).split(".");
  const grouped = grouping.format(BigInt(whole));
  return `${negative ? "-" : ""}${grouped}${fraction === undefined ? "" : `.${fraction}`}`;
}

// A mid price (bid + ask) / 2 has one more decimal than the tick: shown at
// decimals + 1 unless that extra digit is 0, so BTC reads 84,242.95 or 84,242.90.
export function formatMid(value: string, decimals: number): string {
  const extra = roundDecimal(value, decimals + 1);
  return formatPrice(value, extra !== null && extra.endsWith("0") ? decimals : decimals + 1);
}

// "7.7886" -> "+7.79%", "-0.312" -> "-0.31%", "0" -> "0.00%".
export function formatChange(pct: string): string {
  const rounded = roundDecimal(pct, 2);
  if (rounded === null) return "--";
  const isZero = !/[1-9]/.test(rounded);
  return `${rounded.startsWith("-") || isZero ? "" : "+"}${rounded}%`;
}

// KuCoin sends changeRate as a fraction ("-0.003"); multiply by 100 by moving
// the decimal point: "-0.003" -> "-0.3". Null for anything that is not a decimal.
export function fractionToPercent(rate: string): string | null {
  const match = DECIMAL.exec(rate);
  if (!match) return null;
  const fraction = match[3] ?? "";
  const moved = match[2] + fraction.padEnd(2, "0").slice(0, 2);
  const whole = moved.replace(/^0+(?=\d)/, "");
  const rest = fraction.slice(2);
  const text = rest === "" ? whole : `${whole}.${rest}`;
  return match[1] === "-" && /[1-9]/.test(text) ? `-${text}` : text;
}

// Sorting only: a float is fine for ordering rows, never for display or money.
export function toSortNumber(value: string): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}
