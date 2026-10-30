// Order book math on exact integers (BigInt units), never floats. Prices are held in
// units of 10^-priceDecimals and quantities in units of 1e-18, so any depth a
// provider sends sums exactly. Display only: orders never read a book.
export type Level = { price: string; qty: string };
export type TotalLevel = Level & { total: string };
export type Ladder = { bids: Level[]; asks: Level[] };

const QTY_SCALE = 18;
const DECIMAL = /^(\d+)(?:\.(\d+))?$/;

// "1.08500", 5 -> 108500n. Extra decimals are cut off; anything that is not a plain decimal is 0.
export function toUnits(value: string, decimals: number): bigint {
  const match = DECIMAL.exec(value);
  if (!match) return BigInt(0);
  return BigInt(match[1] + (match[2] ?? "").padEnd(decimals, "0").slice(0, decimals));
}

// 108500n, 5 -> "1.08500".
export function fromUnits(units: bigint, decimals: number): string {
  if (decimals === 0) return units.toString();
  const digits = units.toString().padStart(decimals + 1, "0");
  return `${digits.slice(0, digits.length - decimals)}.${digits.slice(digits.length - decimals)}`;
}

// A quantity from 1e-18 units without trailing zeros: "1.5", "20".
function qtyText(units: bigint): string {
  const text = fromUnits(units, QTY_SCALE).replace(/0+$/, "");
  return text.endsWith(".") ? text.slice(0, -1) : text;
}

// Cumulative quantity from the best level outwards.
export function withTotals(levels: Level[]): TotalLevel[] {
  let sum = BigInt(0);
  return levels.map((l) => {
    sum += toUnits(l.qty, QTY_SCALE);
    return { ...l, total: qtyText(sum) };
  });
}

// Buckets best-first levels by `multiplier` ticks (a tick is 10^-priceDecimals). Asks round
// up to their bucket and bids round down, so a grouped price never beats the real one;
// quantities in a bucket add up. Order stays best first.
export function groupLevels(levels: Level[], side: "ask" | "bid", priceDecimals: number, multiplier: number): Level[] {
  const step = BigInt(Math.max(1, Math.floor(multiplier)));
  const out: { bucket: bigint; qty: bigint }[] = [];
  for (const level of levels) {
    const units = toUnits(level.price, priceDecimals);
    const floor = (units / step) * step;
    const bucket = side === "ask" && floor !== units ? floor + step : floor;
    const qty = toUnits(level.qty, QTY_SCALE);
    const last = out[out.length - 1];
    if (last && last.bucket === bucket) last.qty += qty;
    else out.push({ bucket, qty });
  }
  return out.map((o) => ({ price: fromUnits(o.bucket, priceDecimals), qty: qtyText(o.qty) }));
}

// FNV-1a over the seed text, then mulberry32: small, fast and the same everywhere.
function seeded(seed: string): () => number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 0x01000193);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// One level is about this many base units; sizes grow outwards from the mid.
const LOT = 25_000;

// A ladder around `mid` for an instrument with no public depth. Deterministic: the same
// id, minute and settings always give the same book, so nothing jitters between renders
// and it moves once a minute. The tick is 10^-priceDecimals; the spread is 1 to 3 ticks and
// each step out is 1 to 3 ticks, so prices are strictly monotonic. Quantities have
// qtyDecimals decimals. Best level first on both sides.
export function generateLadder(input: {
  id: string;
  mid: string;
  priceDecimals: number;
  qtyDecimals: number;
  levels: number;
  minute: number;
}): Ladder {
  const { id, mid, priceDecimals, qtyDecimals, levels, minute } = input;
  const midUnits = toUnits(mid, priceDecimals);
  const random = seeded(`${id}|${minute}`);
  const spread = 1 + Math.floor(random() * 3);
  const bestBid = midUnits - BigInt(Math.floor(spread / 2));
  const bestAsk = bestBid + BigInt(spread);
  const empty: Ladder = { bids: [], asks: [] };
  if (midUnits <= BigInt(0) || bestBid <= BigInt(0)) return empty;

  const qty = (i: number) =>
    fromUnits(BigInt(1 + Math.floor(random() * 40) + Math.floor(i * 1.5)) * BigInt(LOT) * BigInt(10) ** BigInt(qtyDecimals), qtyDecimals);
  const gap = () => BigInt(1 + Math.floor(random() * 3));

  const asks: Level[] = [];
  let ask = bestAsk;
  for (let i = 0; i < levels; i++) {
    asks.push({ price: fromUnits(ask, priceDecimals), qty: qty(i) });
    ask += gap();
  }
  const bids: Level[] = [];
  let bid = bestBid;
  for (let i = 0; i < levels && bid > BigInt(0); i++) {
    bids.push({ price: fromUnits(bid, priceDecimals), qty: qty(i) });
    bid -= gap();
  }
  return { bids, asks };
}
