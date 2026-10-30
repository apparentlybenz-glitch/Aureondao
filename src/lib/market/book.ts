import { isPositiveDecimal } from "./decimal";
import { ProviderError } from "./types";
import type { Market } from "./types";

// Exchange depth and recent trades for the selected symbol. Display only:
// orders never enter this book and never read it.
export const BOOK_LEVELS = 20; // Vision depth weight 5 for limits 1 to 100
export const TRADES_LIMIT = 30; // Vision aggTrades weight 4
export const BOOK_POLL_MS = 5_000;
export const BOOK_TIMEOUT_MS = 4_000;

export type BookLevel = { price: string; qty: string };
export type Book = { bids: BookLevel[]; asks: BookLevel[] };
export type Trade = { id: number; price: string; qty: string; time: number; side: "buy" | "sell" };

export function visionDepthUrl(market: Pick<Market, "visionSymbol">): string {
  return `https://data-api.binance.vision/api/v3/depth?symbol=${market.visionSymbol}&limit=${BOOK_LEVELS}`;
}

export function visionTradesUrl(market: Market): string {
  return `https://data-api.binance.vision/api/v3/aggTrades?symbol=${market.visionSymbol}&limit=${TRADES_LIMIT}`;
}

function levels(rows: unknown): BookLevel[] {
  if (!Array.isArray(rows)) throw new ProviderError("Unexpected depth payload");
  const out: BookLevel[] = [];
  for (const row of rows) {
    if (Array.isArray(row) && isPositiveDecimal(row[0]) && isPositiveDecimal(row[1])) {
      out.push({ price: row[0], qty: row[1] });
    }
  }
  return out;
}

// Bids best (highest) first, asks best (lowest) first, as Vision sends them.
export function normalizeVisionDepth(payload: unknown): Book {
  const p = payload as { bids?: unknown; asks?: unknown } | null;
  if (!p || typeof p !== "object") throw new ProviderError("Unexpected depth payload");
  return { bids: levels(p.bids), asks: levels(p.asks) };
}

// Newest first. m = true means the buyer was the maker, so the taker sold.
export function normalizeVisionTrades(payload: unknown): Trade[] {
  if (!Array.isArray(payload)) throw new ProviderError("Unexpected trades payload");
  const out: Trade[] = [];
  for (const row of payload as Record<string, unknown>[]) {
    if (
      row &&
      typeof row.a === "number" &&
      isPositiveDecimal(row.p) &&
      isPositiveDecimal(row.q) &&
      typeof row.T === "number" &&
      typeof row.m === "boolean"
    ) {
      out.push({ id: row.a, price: row.p, qty: row.q, time: row.T, side: row.m ? "sell" : "buy" });
    }
  }
  return out.sort((a, b) => b.time - a.time || b.id - a.id);
}
