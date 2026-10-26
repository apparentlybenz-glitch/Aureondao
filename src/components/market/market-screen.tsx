"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { MarketTable } from "./market-table";

// The Market tab. The top bar search lands here as /market?q=; the field below
// follows that value whenever it changes and can then be edited freely.
export function MarketScreen() {
  const q = useSearchParams().get("q") ?? "";
  const [draft, setDraft] = useState(q);
  const [seen, setSeen] = useState(q);
  if (q !== seen) {
    setSeen(q);
    setDraft(q);
  }
  return <MarketTable variant="market" query={draft} onQueryChange={setDraft} />;
}
