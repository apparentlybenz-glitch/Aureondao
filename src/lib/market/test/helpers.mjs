import { readFileSync } from "node:fs";

export const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`../__fixtures__/${name}`, import.meta.url), "utf8"));

// The 20 seeded markets, built from the Vision fixture's symbols (all quoted in USDT).
export function seededMarkets() {
  return fixture("vision-24hr.json").map((row, i) => {
    const base = row.symbol.slice(0, -4);
    return {
      id: `${base}-USDT`,
      base,
      quote: "USDT",
      displaySymbol: `${base}USD`,
      visionSymbol: row.symbol,
      kucoinSymbol: `${base}-USDT`,
      priceDecimals: 2,
      sortOrder: i + 1,
      qtyDecimals: 5,
      minNotionalCents: 500n,
    };
  });
}
