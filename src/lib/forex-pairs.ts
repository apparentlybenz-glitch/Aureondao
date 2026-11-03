// TradingView chart symbols for the enabled Forex instruments. Instruments themselves
// (ids, names, decimals, class, order) come from the fx_instruments table.
//
// Currency pairs are FX:<PAIR>; gold and silver are OANDA:XAUUSD and OANDA:XAGUSD, with
// TVC:GOLD and TVC:SILVER as alternates if OANDA does not render. Not seen rendering from
// the agent sandbox (the widget host is unreachable there), so all 13 are unverified.
export const FOREX_TV_ALTERNATES: Readonly<Record<string, string>> = {
  "XAU-USD": "TVC:GOLD",
  "XAG-USD": "TVC:SILVER",
};

// "EUR-USD" -> "FX:EURUSD", "XAU-USD" -> "OANDA:XAUUSD".
export function forexTvSymbol(id: string): string {
  const pair = id.replace("-", "");
  return id === "XAU-USD" || id === "XAG-USD" ? `OANDA:${pair}` : `FX:${pair}`;
}
