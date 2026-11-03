"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { parseMarketType } from "@/lib/market/market-types";
import type { MarketType } from "@/lib/market/market-types";
import { MarketTable } from "./market-table";

// The Market tab. The top bar search lands here as /market?q=; the field below
// follows that value whenever it changes and can then be edited freely. ?type= picks the
// category (Spot or Forex); anything else, such as an old ?type=options, is Spot.
export function MarketScreen() {
  const params = useSearchParams();
  const q = params.get("q") ?? "";
  const [type, setType] = useState<MarketType>(() => parseMarketType(params.get("type")));
  const [draft, setDraft] = useState(q);
  const [seen, setSeen] = useState(q);
  if (q !== seen) {
    setSeen(q);
    setDraft(q);
  }
  return <MarketTable variant="market" query={draft} onQueryChange={setDraft} type={type} onTypeChange={setType} />;
}
