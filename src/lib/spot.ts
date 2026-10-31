"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { centsFromText } from "@/lib/money";
import { createClient } from "@/lib/supabase/client";

// Spot account reads (RLS: own rows only). Numeric and bigint columns are
// selected as text (hard rule 1), so quantities stay strings and cents BigInt.
// qty is the available quantity; held is the part reserved by open sell limit orders.
export type Holding = { asset: string; qty: string; held: string; costBasis: bigint };
// A filled order (market, or a limit order that filled): price, notional and fee are set.
export type SpotOrder = {
  id: string;
  marketId: string;
  type: "market" | "limit";
  side: "buy" | "sell";
  qty: string;
  limitPrice: string | null;
  price: string;
  notional: bigint;
  fee: bigint;
  realizedPnl: bigint | null;
  createdAt: string;
};
// A resting limit order. A buy reserves holdCents (cost plus fee), a sell reserves holdQty.
export type OpenOrder = {
  id: string;
  marketId: string;
  side: "buy" | "sell";
  qty: string;
  limitPrice: string;
  holdCents: bigint | null;
  holdQty: string | null;
  createdAt: string;
};

type HoldingRow = { asset: string; available_qty: string; held_qty: string; cost_basis_cents: string };
type OrderRow = {
  id: string;
  market_id: string;
  type: "market" | "limit";
  side: "buy" | "sell";
  qty: string;
  limit_price: string | null;
  price: string;
  notional_cents: string;
  fee_cents: string;
  realized_pnl_cents: string | null;
  created_at: string;
};
type OpenOrderRow = {
  id: string;
  market_id: string;
  side: "buy" | "sell";
  qty: string;
  limit_price: string;
  hold_cents: string | null;
  hold_qty: string | null;
  created_at: string;
};

const HOLDING_SELECT = "asset, available_qty::text, held_qty::text, cost_basis_cents::text";
const ORDER_SELECT =
  "id, market_id, type, side, qty::text, limit_price::text, price::text, notional_cents::text, fee_cents::text, realized_pnl_cents::text, created_at";
const OPEN_ORDER_SELECT = "id, market_id, side, qty::text, limit_price::text, hold_cents::text, hold_qty::text, created_at";
export const ORDER_HISTORY_LIMIT = 50;

function toOrder(r: OrderRow): SpotOrder {
  return {
    id: r.id,
    marketId: r.market_id,
    type: r.type,
    side: r.side,
    qty: r.qty,
    limitPrice: r.limit_price,
    price: r.price,
    notional: centsFromText(r.notional_cents),
    fee: centsFromText(r.fee_cents),
    realizedPnl: r.realized_pnl_cents === null ? null : centsFromText(r.realized_pnl_cents),
    createdAt: r.created_at,
  };
}

function toOpenOrder(r: OpenOrderRow): OpenOrder {
  return {
    id: r.id,
    marketId: r.market_id,
    side: r.side,
    qty: r.qty,
    limitPrice: r.limit_price,
    holdCents: r.hold_cents === null ? null : centsFromText(r.hold_cents),
    holdQty: r.hold_qty,
    createdAt: r.created_at,
  };
}

// The filled order row as stored, read back after a fill (the RPC's own response
// carries numbers as JSON floats, so it is not used for display). An order that is
// not filled has no price or notional, so it reads as null.
export async function fetchOrder(id: string): Promise<SpotOrder | null> {
  const { data, error } = await createClient()
    .from("orders")
    .select(ORDER_SELECT)
    .eq("id", id)
    .eq("status", "filled")
    .maybeSingle()
    .overrideTypes<OrderRow, { merge: false }>();
  return error || !data ? null : toOrder(data);
}

type AccountData = { holdings: Holding[]; orders: SpotOrder[]; openOrders: OpenOrder[] };

async function fetchAccount(): Promise<AccountData | null> {
  const supabase = createClient();
  const [h, o, open] = await Promise.all([
    supabase
      .from("spot_holdings")
      .select(HOLDING_SELECT)
      .or("available_qty.gt.0,held_qty.gt.0")
      .order("asset")
      .overrideTypes<HoldingRow[], { merge: false }>(),
    supabase
      .from("orders")
      .select(ORDER_SELECT)
      .eq("status", "filled")
      .order("created_at", { ascending: false })
      .limit(ORDER_HISTORY_LIMIT)
      .overrideTypes<OrderRow[], { merge: false }>(),
    supabase
      .from("orders")
      .select(OPEN_ORDER_SELECT)
      .eq("status", "open")
      .order("created_at", { ascending: false })
      .overrideTypes<OpenOrderRow[], { merge: false }>(),
  ]);
  if (h.error || o.error || open.error) return null;
  return {
    holdings: h.data.map((r) => ({
      asset: r.asset,
      qty: r.available_qty,
      held: r.held_qty,
      costBasis: centsFromText(r.cost_basis_cents),
    })),
    orders: o.data.map(toOrder),
    openOrders: open.data.map(toOpenOrder),
  };
}

// Holdings, the newest filled orders and the open limit orders. They are not pushed live;
// every order changes the Spot wallet, which is, so callers pass the Spot available and
// held balances as `refreshOn` and the lists reload when either changes (a resting sell
// moves quantity, not cash, and a buy fill moves cash from held to a holding, so the
// available balance alone is not enough). Place and cancel also call `reload`.
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

  return { holdings: data?.holdings ?? null, orders: data?.orders ?? null, openOrders: data?.openOrders ?? null, error, reload };
}

// Cancels an open limit order (spot_cancel_order). Returns the RPC error, or null on success;
// a second cancel of the same order succeeds too.
export async function cancelOrder(id: string): Promise<{ code?: string; message: string } | null> {
  const { error } = await createClient().rpc("spot_cancel_order", { p_order_id: id });
  return error;
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
