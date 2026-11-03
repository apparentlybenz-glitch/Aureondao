// Forex display helpers, pure and self-contained (unit-tested with node:test). Prices are
// decimal strings and never pass through a float; times are New York (ET) as the product
// states them.

export type PricePoint = { ts: string; price: string };

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const DAY_AGO_TOLERANCE_MS = 30 * 60_000;

// The stored print nearest to lastTs minus 24 hours, within plus or minus 30 minutes; null when
// there is none. On a tie the earlier print wins.
export function dayAgoPrint(rows: readonly PricePoint[], lastTs: string): PricePoint | null {
  const target = Date.parse(lastTs) - DAY_MS;
  if (Number.isNaN(target)) return null;
  let best: PricePoint | null = null;
  let bestGap = Number.POSITIVE_INFINITY;
  for (const row of rows) {
    const at = Date.parse(row.ts);
    if (Number.isNaN(at)) continue;
    const gap = Math.abs(at - target);
    if (gap > DAY_AGO_TOLERANCE_MS) continue;
    if (gap < bestGap || (gap === bestGap && best !== null && at < Date.parse(best.ts))) {
      best = row;
      bestGap = gap;
    }
  }
  return best;
}

const DECIMAL = /^(\d+)(?:\.(\d+))?$/;

// (last - prev) / prev x 100 as a decimal string with 4 decimals, truncated toward zero, by
// BigInt math. Null when either price is not a positive plain decimal.
export function changePercent(last: string, prev: string): string | null {
  const a = DECIMAL.exec(last);
  const b = DECIMAL.exec(prev);
  if (!a || !b) return null;
  const scale = Math.max(a[2]?.length ?? 0, b[2]?.length ?? 0);
  const toInt = (m: RegExpExecArray) => BigInt(m[1] + (m[2] ?? "").padEnd(scale, "0"));
  const l = toInt(a);
  const p = toInt(b);
  if (p === BigInt(0) || l === BigInt(0)) return null;
  const scaled = ((l - p) * BigInt(1_000_000)) / p; // percent x 10^4
  const negative = scaled < BigInt(0);
  const abs = (negative ? -scaled : scaled).toString().padStart(5, "0");
  const text = `${abs.slice(0, -4)}.${abs.slice(-4)}`;
  return negative ? `-${text}` : text;
}

const etWeekday = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "long" });
const etClock = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});
const etStamp = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

// "Sunday" and "5:00 PM" in New York time; the page adds the ET label from en.json.
export function etParts(iso: string): { weekday: string; time: string } | null {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  return { weekday: etWeekday.format(at), time: etClock.format(at).replace(/ /g, " ") };
}

// "Nov 3, 5:00 PM" in New York time (a position's opened and end times).
export function etStampText(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? "--" : etStamp.format(at).replace(/ /g, " ");
}

// The two Forex classes request_fx_feed reports on.
export type FxClass = "fx" | "metal";

export type ClassStatus = { closed: boolean; opensAt: string | null; closesAt: string | null };
export type FeedStatus = Record<FxClass, ClassStatus>;

function readClass(value: unknown): ClassStatus | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.closed !== "boolean") return null;
  const text = (x: unknown) => (typeof x === "string" ? x : null);
  return { closed: v.closed, opensAt: text(v.opens_at), closesAt: text(v.closes_at) };
}

// request_fx_feed returns { fx: {closed, opens_at, closes_at}, metal: {...}, demand_until }.
export function parseFeedStatus(body: unknown): FeedStatus | null {
  if (typeof body !== "object" || body === null) return null;
  const v = body as Record<string, unknown>;
  const fx = readClass(v.fx);
  const metal = readClass(v.metal);
  return fx && metal ? { fx, metal } : null;
}

// Duration chip text: 3600 -> { unit: "hours", value: 1 }, 5400 -> { unit: "minutes", value: 90 }.
export function durationParts(durationS: number): { unit: "hours" | "minutes"; value: number } {
  return durationS % 3600 === 0
    ? { unit: "hours", value: durationS / 3600 }
    : { unit: "minutes", value: Math.round(durationS / 60) };
}

// "EUR-USD" -> "EUR/USD".
export function fxDisplay(id: string): string {
  return id.replace("-", "/");
}
