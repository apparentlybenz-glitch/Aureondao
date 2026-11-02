import { formatMid } from "./market/decimal";
import type { Market } from "./market/types";
import { formatCents } from "./money";
import type { OptionPosition } from "./options";

// The one shape the share card draws. Options builds it from a settled position;
// Forex builds the same shape once it has a list of settled trades.
export type ShareTrade = {
  win: boolean;
  percent: string; // "+6.00%" or "-100.00%", on the premium
  amount: string; // "+294.00" or "-4,900.00", USD, fee not included
  base: string; // coin symbol for the icon
  pair: string; // BTC/USDT
  side: "call" | "put";
  durationS: number;
  product: "options";
  premium: string; // USD, grouped
  strike: string; // entry price
};

// Return on the premium in hundredths of a percent, truncated toward zero.
export function returnBps(profit: bigint, premium: bigint): bigint {
  return (profit * BigInt(10000)) / premium;
}

export function formatBps(bps: bigint): string {
  const negative = bps < BigInt(0);
  const abs = negative ? -bps : bps;
  const text = `${abs / BigInt(100)}.${(abs % BigInt(100)).toString().padStart(2, "0")}%`;
  return negative ? `-${text}` : bps > BigInt(0) ? `+${text}` : text;
}

// A win or a loss only: a draw or a void has no result to share, so it returns null.
export function optionShareTrade(p: OptionPosition, market: Market | undefined): ShareTrade | null {
  if (p.status !== "settled" || (p.result !== "win" && p.result !== "loss") || p.payout === null) return null;
  const profit = p.payout - p.premium;
  return {
    win: p.result === "win",
    percent: formatBps(returnBps(profit, p.premium)),
    amount: formatCents(profit, { sign: true }),
    base: market?.base ?? p.marketId.split("-")[0],
    pair: market?.displaySymbol ?? p.marketId.replace("-", "/"),
    side: p.direction === "rise" ? "call" : "put",
    durationS: p.durationS,
    product: "options",
    premium: formatCents(p.premium),
    strike: market ? formatMid(p.entryPrice, market.priceDecimals) : p.entryPrice,
  };
}
