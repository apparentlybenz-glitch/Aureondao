import type { ReactNode } from "react";
import { COINS } from "@/lib/coins";

export type FaqItem = { id: string; question: string; answer: ReactNode };

// Keys under `Faq.items` in messages/en.json, in display order.
export const FAQ_KEYS = [
  "deposit",
  "depositTime",
  "withdrawTime",
  "trade",
  "start",
  "fees",
  "verification",
  "security",
  "prices",
  "support",
] as const;

type Translate = (key: string, values?: Record<string, string>) => string;

function joinList(names: readonly string[]): string {
  return names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

// Item 1 names the deposit coins from the shared config (src/lib/coins.ts).
// No minimum amounts exist in the app, so it is a plain explanation, not a table.
export function buildFaqItems(t: Translate, coinName: (symbol: string) => string): FaqItem[] {
  const coins = joinList(COINS.map((c) => coinName(c.symbol)));
  return FAQ_KEYS.map((key) => ({
    id: key,
    question: t(`items.${key}.question`),
    answer: <p>{t(`items.${key}.answer`, { coins })}</p>,
  }));
}
