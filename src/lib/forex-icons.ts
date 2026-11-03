// Which icon each currency or metal gets. Pure data so the map is unit-tested against the files.
// Flags are the circle-flags set (MIT, HatScripts) copied into public/icons/flags with its license.
export const CURRENCY_FLAG: Readonly<Record<string, string>> = {
  USD: "us",
  EUR: "eu",
  GBP: "gb",
  JPY: "jp",
  CHF: "ch",
  CAD: "ca",
  AUD: "au",
  NZD: "nz",
};

// Metals are drawn as inline badges by the component.
export const METAL_BADGE: Readonly<Record<string, "gold" | "silver">> = { XAU: "gold", XAG: "silver" };

export type CurrencyIcon = { kind: "flag"; file: string } | { kind: "metal"; metal: "gold" | "silver" } | { kind: "badge" };

// A currency code to its icon; an unknown code is the initials badge.
export function currencyIcon(code: string): CurrencyIcon {
  const file = CURRENCY_FLAG[code];
  if (file) return { kind: "flag", file };
  const metal = METAL_BADGE[code];
  if (metal) return { kind: "metal", metal };
  return { kind: "badge" };
}

// "EUR-USD" -> { base: "EUR", quote: "USD" }.
export function instrumentParts(id: string): { base: string; quote: string } {
  const [base = "", quote = ""] = id.split("-");
  return { base, quote };
}
