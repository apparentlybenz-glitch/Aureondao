// The Forex page reads its pairs only from here. Everything is a placeholder
// until the pricing session replaces it: mid is a static decimal string, icon
// is the text drawn in a plain circle.
export type ForexPair = {
  symbol: string; // EURUSD
  display: string; // EUR/USD
  name: string;
  mid: string; // static placeholder, decimal string
  priceDecimals: number;
  icon: string;
};

export const FOREX_PAIRS: readonly ForexPair[] = [
  { symbol: "EURUSD", display: "EUR/USD", name: "Euro / US Dollar", mid: "1.08500", priceDecimals: 5, icon: "EU" },
  { symbol: "GBPUSD", display: "GBP/USD", name: "British Pound / US Dollar", mid: "1.27000", priceDecimals: 5, icon: "GB" },
  { symbol: "USDJPY", display: "USD/JPY", name: "US Dollar / Japanese Yen", mid: "150.000", priceDecimals: 3, icon: "UJ" },
];
