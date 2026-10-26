import { NextResponse } from "next/server";
import { getKucoinTickers } from "@/lib/market/md-server";

// Crypto fallback for the browser store when Vision is unreachable. Display
// data only: no money path reads it. A GET route handler is prerendered unless
// told otherwise, so this one is forced dynamic.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const tickers = await getKucoinTickers();
    return NextResponse.json(
      { source: "kucoin", tickers },
      { headers: { "Cache-Control": "public, max-age=0, s-maxage=5" } },
    );
  } catch {
    return NextResponse.json(
      { error: "market_data_unavailable" },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}
