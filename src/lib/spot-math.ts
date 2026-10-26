// Spot order estimates with BigInt decimal math (no floats). The server
// recomputes everything from its own snapshot; these numbers are only shown
// as an estimate. Rounding mirrors the SQL: cost and fee round up, sell
// proceeds round down (docs/data-model.md §16.2).
const ZERO = BigInt(0);
const ONE = BigInt(1);
const TEN = BigInt(10);
const HUNDRED = BigInt(100);
const BPS = BigInt(10_000);

type Scaled = { n: bigint; scale: number };

function scaled(value: string): Scaled {
  const [whole, fraction = ""] = value.split(".");
  return { n: BigInt(whole + fraction), scale: fraction.length };
}

const pow10 = (k: number) => TEN ** BigInt(k);

function divRound(num: bigint, den: bigint, mode: "ceil" | "floor"): bigint {
  const q = num / den;
  return mode === "ceil" && num % den !== ZERO ? q + ONE : q;
}

export type QtyCheck =
  | { ok: true; qty: string }
  | { ok: false; reason: "empty" | "format" | "decimals" | "zero" };

// Digits with an optional fraction of at most qtyDecimals places. "0.10" is
// fine for 2 decimals; "1e-3", "-1", ".5" and spaces are not.
export function checkQty(input: string, qtyDecimals: number): QtyCheck {
  if (input === "") return { ok: false, reason: "empty" };
  const match = /^(\d{1,20})(?:\.(\d{0,18}))?$/.exec(input);
  if (!match) return { ok: false, reason: "format" };
  const fraction = (match[2] ?? "").replace(/0+$/, "");
  if (fraction.length > qtyDecimals) return { ok: false, reason: "decimals" };
  const qty = fraction ? `${BigInt(match[1])}.${fraction}` : BigInt(match[1]).toString();
  if (!/[1-9]/.test(qty)) return { ok: false, reason: "zero" };
  return { ok: true, qty };
}

// qty x price in cents, rounded up (buy cost) or down (sell proceeds).
export function valueCents(qty: string, price: string, mode: "ceil" | "floor"): bigint {
  const q = scaled(qty);
  const p = scaled(price);
  return divRound(q.n * p.n * HUNDRED, pow10(q.scale + p.scale), mode);
}

export function feeCents(cents: bigint, feeBps: number): bigint {
  return divRound(cents * BigInt(feeBps), BPS, "ceil");
}

// The minimum is checked on the unrounded order value, as the server does.
export function meetsMinimum(qty: string, price: string, minCents: bigint): boolean {
  const q = scaled(qty);
  const p = scaled(price);
  return q.n * p.n * HUNDRED >= minCents * pow10(q.scale + p.scale);
}

function unitsToQty(units: bigint, qtyDecimals: number): string {
  if (qtyDecimals === 0) return units.toString();
  const text = units.toString().padStart(qtyDecimals + 1, "0");
  const whole = text.slice(0, -qtyDecimals);
  const fraction = text.slice(-qtyDecimals).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

// Headroom for a 100 % buy: the server's snapshot ask can be above the shown one.
export const MAX_BUY_BUFFER_BPS = 50;

// Largest quantity whose estimated cost plus fee fits the budget, priced at the
// shown ask raised by bufferBps (0 for no headroom), rounded down to qtyDecimals.
export function buyQtyFor(
  budgetCents: bigint,
  ask: string,
  feeBps: number,
  qtyDecimals: number,
  bufferBps: number,
): string {
  if (budgetCents <= ZERO) return "0";
  const raw = scaled(ask);
  // ask x (10000 + buffer) / 10000, kept exact by adding 4 decimal places.
  const p = { n: raw.n * (BPS + BigInt(bufferBps)), scale: raw.scale + 4 };
  const unit = pow10(qtyDecimals);
  const total = (units: bigint) => {
    const cost = divRound(units * p.n * HUNDRED, pow10(qtyDecimals + p.scale), "ceil");
    return cost + feeCents(cost, feeBps);
  };
  // Upper bound ignoring rounding, then a binary search for the exact fit.
  let hi = (budgetCents * unit * pow10(p.scale) * BPS) / (p.n * HUNDRED * (BPS + BigInt(feeBps))) + ONE;
  let lo = ZERO;
  while (lo < hi) {
    const mid = (lo + hi + ONE) / BigInt(2);
    if (total(mid) <= budgetCents) lo = mid;
    else hi = mid - ONE;
  }
  return unitsToQty(lo, qtyDecimals);
}

// pct of the holding, rounded down to the allowed decimals.
export function sellQtyFor(holding: string, pct: number, qtyDecimals: number): string {
  const h = scaled(holding);
  const units = (h.n * BigInt(pct) * pow10(qtyDecimals)) / (pow10(h.scale) * HUNDRED);
  return unitsToQty(units, qtyDecimals);
}

// Compare two decimal strings: -1, 0 or 1.
export function compareDecimal(a: string, b: string): number {
  const x = scaled(a);
  const y = scaled(b);
  const l = x.n * pow10(y.scale);
  const r = y.n * pow10(x.scale);
  return l === r ? 0 : l < r ? -1 : 1;
}

// "0.001000000000000000" -> "0.001", "12.000" -> "12".
export function trimDecimal(value: string): string {
  return value.includes(".") ? value.replace(/0+$/, "").replace(/\.$/, "") : value;
}

// (bid + ask) / 2 as an exact decimal string (display only).
export function midPrice(bid: string, ask: string): string {
  const b = scaled(bid);
  const a = scaled(ask);
  const scale = Math.max(b.scale, a.scale) + 1;
  const sum = (b.n * pow10(scale - b.scale) + a.n * pow10(scale - a.scale)) / BigInt(2);
  const text = sum.toString().padStart(scale + 1, "0");
  return trimDecimal(`${text.slice(0, -scale)}.${text.slice(-scale)}`);
}
