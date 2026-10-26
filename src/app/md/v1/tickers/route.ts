import { NextResponse } from "next/server";
import { getKucoinTickers } from "@/lib/market/md-server";

// Crypto fallback for the browser store when Vision is unreachable. Display
// data only: no money path reads it. A GET route handler is prerendered unless
// told otherwise, so this one is forced dynamic.
export const dynamic = "force-dynamic";

// 200 with fresh data; 200 with `stale: true` while KuCoin is failing and the
// last good response is at most 60 s old (each ticker keeps its own ts, so the
// client marks old ones as delayed); 502 after that. Failures are reported in
// md-server.ts when they happen.
export async function GET() {
  try {
    const { value, stale } = await getKucoinTickers();
    return NextResponse.json(
      { source: "kucoin", stale, tickers: value },
      { headers: { "Cache-Control": "public, max-age=0, s-maxage=5" } },
    );
  } catch {
    return NextResponse.json(
      { error: "market_data_unavailable" },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}
