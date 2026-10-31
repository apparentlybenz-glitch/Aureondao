"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { centsFromText } from "@/lib/money";
import { createClient } from "@/lib/supabase/client";

// Spot account reads (RLS: own rows only). Numeric and bigint columns are
// selected as text (hard rule 1), so quantities stay strings and cents BigInt.
export type Holding = { asset: string; qty: string; costBasis: bigint };
export type SpotOrder = {
  id: string;
  marketId: string;
  side: "buy" | "sell";
  qty: string;
  price: string;
  notional: bigint;
  fee: bigint;
  realizedPnl: bigint | null;
  createdAt: string;
};

type HoldingRow = { asset: string; available_qty: string; cost_basis_cents: string };
type OrderRow = {
  id: string;
  market_id: string;
  side: "buy" | "sell";
  qty: string;
  price: string;
  notional_cents: string;
  fee_cents: string;
  realized_pnl_cents: string | null;
  created_at: string;
};

const HOLDING_SELECT = "asset, available_qty::text, cost_basis_cents::text";
const ORDER_SELECT =
  "id, market_id, side, qty::text, price::text, notional_cents::text, fee_cents::text, realized_pnl_cents::text, created_at";
export const ORDER_HISTORY_LIMIT = 50;

function toOrder(r: OrderRow): SpotOrder {
  return {
    id: r.id,
    marketId: r.market_id,
    side: r.side,
    qty: r.qty,
    price: r.price,
    notional: centsFromText(r.notional_cents),
    fee: centsFromText(r.fee_cents),
    realizedPnl: r.realized_pnl_cents === null ? null : centsFromText(r.realized_pnl_cents),
    createdAt: r.created_at,
  };
}

// The order row as stored, read back after a fill (the RPC's own response
// carries numbers as JSON floats, so it is not used for display).
export async function fetchOrder(id: string): Promise<SpotOrder | null> {
  const { data, error } = await createClient()
    .from("orders")
    .select(ORDER_SELECT)
    .eq("id", id)
    .maybeSingle()
    .overrideTypes<OrderRow, { merge: false }>();
  return error || !data ? null : toOrder(data);
}

type AccountData = { holdings: Holding[]; orders: SpotOrder[] };

async function fetchAccount(): Promise<AccountData | null> {
  const supabase = createClient();
  const [h, o] = await Promise.all([
    supabase
      .from("spot_holdings")
      .select(HOLDING_SELECT)
      .gt("available_qty", 0)
      .order("asset")
      .overrideTypes<HoldingRow[], { merge: false }>(),
    supabase
      .from("orders")
      .select(ORDER_SELECT)
      .order("created_at", { ascending: false })
      .limit(ORDER_HISTORY_LIMIT)
      .overrideTypes<OrderRow[], { merge: false }>(),
  ]);
  if (h.error || o.error) return null;
  return {
    holdings: h.data.map((r) => ({ asset: r.asset, qty: r.available_qty, costBasis: centsFromText(r.cost_basis_cents) })),
    orders: o.data.map(toOrder),
  };
}

// Holdings and the newest orders. Orders and holdings are not pushed live; every
// order changes the Spot wallet, which is, so callers pass the Spot balance as
// `refreshOn` and the lists reload when it changes.
export function useSpotAccount(refreshOn: string | null) {
  const [data, setData] = useState<AccountData | null>(null);
  const [error, setError] = useState(false);

  // Latest-wins: the balance-driven load and an explicit reload can overlap.
  const latest = useRef(0);

  const apply = useCallback((result: AccountData | null) => {
    setError(result === null);
    if (result) setData(result);
  }, []);

  useEffect(() => {
    if (refreshOn === null) return;
    const ticket = ++latest.current;
    void fetchAccount().then((result) => {
      if (ticket === latest.current) apply(result);
    });
  }, [refreshOn, apply]);

  const reload = useCallback(() => {
    const ticket = ++latest.current;
    return fetchAccount().then((result) => {
      if (ticket === latest.current) apply(result);
    });
  }, [apply]);

  return { holdings: data?.holdings ?? null, orders: data?.orders ?? null, error, reload };
}

// The Spot fee rate from the config row (never hard-coded).
export function useSpotFeeBps(): number | null {
  const [bps, setBps] = useState<number | null>(null);
  useEffect(() => {
    let active = true;
    createClient()
      .from("spot_config")
      .select("fee_bps")
      .maybeSingle()
      .then(({ data }) => {
        if (active && data) setBps((data as { fee_bps: number }).fee_bps);
      });
    return () => {
      active = false;
    };
  }, []);
  return bps;
}

export const PRICE_FEED_HEARTBEAT_MS = 60_000;

// Keeps the server price feed running while a trading screen is mounted and its
// tab is visible: one call on show, then every minute; nothing while hidden.
// The server writes the demand window at most about once a minute and keeps it
// open for 5 minutes after the last write.
export function usePriceFeedDemand() {
  useEffect(() => {
    const supabase = createClient();
    let timer: ReturnType<typeof setInterval> | null = null;
    // The query builder is lazy: it sends nothing until it is awaited or then'd.
    const beat = () => void supabase.rpc("request_price_feed").then(() => undefined);
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };
    const start = () => {
      stop();
      beat();
      timer = setInterval(beat, PRICE_FEED_HEARTBEAT_MS);
    };
    const onVisibility = () => (document.visibilityState === "hidden" ? stop() : start());
    if (document.visibilityState !== "hidden") start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);
}
