// The Forex page reads its pairs only from here. Everything is a placeholder
// until the pricing session replaces it: mid is a static decimal string, icon
// is the text drawn in a plain circle.
export type ForexPair = {
  symbol: string; // EURUSD
  tvSymbol: string; // FX:EURUSD, see forexTvSymbol
  display: string; // EUR/USD
  name: string;
  mid: string; // static placeholder, decimal string
  priceDecimals: number;
  icon: string;
};

// TradingView chart symbols. Currency pairs are FX:<PAIR>; gold and silver are
// OANDA:XAUUSD and OANDA:XAGUSD, with TVC:GOLD and TVC:SILVER as alternates if
// OANDA does not render.
export const FOREX_TV_ALTERNATES: Readonly<Record<string, string>> = {
  XAUUSD: "TVC:GOLD",
  XAGUSD: "TVC:SILVER",
};

export function forexTvSymbol(symbol: string): string {
  return symbol === "XAUUSD" || symbol === "XAGUSD" ? `OANDA:${symbol}` : `FX:${symbol}`;
}

export const FOREX_PAIRS: readonly ForexPair[] = [
  { symbol: "EURUSD", tvSymbol: "FX:EURUSD", display: "EUR/USD", name: "Euro / US Dollar", mid: "1.08500", priceDecimals: 5, icon: "EU" },
  { symbol: "GBPUSD", tvSymbol: "FX:GBPUSD", display: "GBP/USD", name: "British Pound / US Dollar", mid: "1.27000", priceDecimals: 5, icon: "GB" },
  { symbol: "USDJPY", tvSymbol: "FX:USDJPY", display: "USD/JPY", name: "US Dollar / Japanese Yen", mid: "150.000", priceDecimals: 3, icon: "UJ" },
];
