import { NextResponse } from "next/server";
import { isInterval } from "@/lib/market/klines";
import { findEnabledMarket, getKucoinKlines } from "@/lib/market/md-server";

// Chart fallback for the browser when Vision klines fail. Display data only.
// Same cache and stale rules as /md/v1/tickers: fresh for 5 s, no KuCoin call
// for 10 s after a failure, the last good candles served (stale: true) for up
// to 60 s, then 502. Only enabled markets and the 8 chart intervals are served.
export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const interval = params.get("interval");
  const symbol = params.get("symbol") ?? "";
  if (!isInterval(interval)) {
    return NextResponse.json({ error: "bad_request" }, { status: 400, headers: noStore });
  }
  try {
    const market = await findEnabledMarket(symbol);
    if (!market) return NextResponse.json({ error: "bad_request" }, { status: 400, headers: noStore });
    const { value, stale } = await getKucoinKlines(market, interval);
    return NextResponse.json(
      { source: "kucoin", stale, candles: value },
      { headers: { "Cache-Control": "public, max-age=0, s-maxage=5" } },
    );
  } catch {
    return NextResponse.json({ error: "market_data_unavailable" }, { status: 502, headers: noStore });
  }
}
