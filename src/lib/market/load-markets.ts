import { createClient } from "@/lib/supabase/client";
import { MARKET_COLUMNS, toMarket } from "./types";
import type { Market, MarketRow } from "./types";

// Enabled markets, read under RLS with the browser client.
export async function loadMarkets(): Promise<Market[]> {
  const { data, error } = await createClient()
    .from("markets")
    .select(MARKET_COLUMNS)
    .eq("enabled", true)
    .order("sort_order")
    .overrideTypes<MarketRow[], { merge: false }>();
  if (error) throw new Error(error.message);
  return data.map(toMarket);
}
