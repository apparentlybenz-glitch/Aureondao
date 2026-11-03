"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { dayAgoPrint, parseFeedStatus } from "@/lib/forex-math";
import type { FeedStatus, FxClass, PricePoint } from "@/lib/forex-math";
import { centsFromText } from "@/lib/money";
import { onVisible } from "@/lib/on-visible";
import type { Direction } from "@/lib/options";
import { createClient } from "@/lib/supabase/client";

// Forex reads (RLS: instruments, periods and prices for any signed-in user, positions own
// rows only). Numeric and bigint columns are selected as text (hard rule 1). fx_positions and
// fx_prices are in the Realtime publication; every channel name gets a random suffix (rule 7).

export type FxInstrument = {
  id: string; // EUR-USD
  base: string;
  quote: string;
  cls: FxClass;
  priceDecimals: number;
};

type InstrumentRow = { id: string; base: string; quote: string; class: FxClass; price_decimals: number };

// Enabled instruments in sort order.
export function useFxInstruments(): FxInstrument[] | null {
  const [list, setList] = useState<FxInstrument[] | null>(null);
  useEffect(() => {
    let active = true;
    void createClient()
      .from("fx_instruments")
      .select("id, base, quote, class, price_decimals")
      .eq("enabled", true)
      .order("sort_order")
      .overrideTypes<InstrumentRow[], { merge: false }>()
      .then(({ data, error }) => {
        if (!active || error) return;
        setList(
          data.map((r) => ({ id: r.id, base: r.base, quote: r.quote, cls: r.class, priceDecimals: r.price_decimals })),
        );
      });
    return () => {
      active = false;
    };
  }, []);
  return list;
}

const DAY_MS = 24 * 3_600_000;
const WINDOW_MS = 30 * 60_000;

type PriceRow = { ts: string; price: string };

export type FxPrice = {
  loaded: boolean;
  last: PricePoint | null; // newest print for the instrument
  dayAgo: PricePoint | null; // print nearest 24 h before it, within 30 minutes
};

// The newest fx_prices row for one instrument and the print about a day before it, reloaded
// when a new print is inserted (Realtime), on subscribe and when the tab becomes visible.
export function useFxPrice(instrumentId: string): FxPrice {
  const [state, setState] = useState<FxPrice & { id: string }>({ id: instrumentId, loaded: false, last: null, dayAgo: null });
  const latest = useRef(0);

  useEffect(() => {
    const supabase = createClient();
    let active = true;
    const load = async () => {
      const ticket = ++latest.current;
      const newest = await supabase
        .from("fx_prices")
        .select("ts, price::text")
        .eq("instrument_id", instrumentId)
        .order("ts", { ascending: false })
        .limit(1)
        .overrideTypes<PriceRow[], { merge: false }>();
      if (!active || ticket !== latest.current || newest.error) return;
      const last = newest.data[0] ?? null;
      let dayAgo: PricePoint | null = null;
      if (last) {
        const target = Date.parse(last.ts) - DAY_MS;
        const around = await supabase
          .from("fx_prices")
          .select("ts, price::text")
          .eq("instrument_id", instrumentId)
          .gte("ts", new Date(target - WINDOW_MS).toISOString())
          .lte("ts", new Date(target + WINDOW_MS).toISOString())
          .overrideTypes<PriceRow[], { merge: false }>();
        if (!active || ticket !== latest.current) return;
        if (!around.error) dayAgo = dayAgoPrint(around.data, last.ts);
      }
      setState({ id: instrumentId, loaded: true, last, dayAgo });
    };
    void load();
    const channel = supabase
      .channel(`fx_prices:${crypto.randomUUID()}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "fx_prices", filter: `instrument_id=eq.${instrumentId}` },
        () => void load(),
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") void load();
      });
    const stopVisible = onVisible(() => void load());
    return () => {
      active = false;
      stopVisible();
      void supabase.removeChannel(channel);
    };
  }, [instrumentId]);

  // A switch of instrument shows "loading" until its own rows arrive.
  return state.id === instrumentId ? state : { loaded: false, last: null, dayAgo: null };
}

export const FX_FEED_HEARTBEAT_MS = 60_000;

// Keeps the Forex price feed running while the screen is mounted and its tab is visible: one
// call on show, then every minute; nothing while hidden (usePriceFeedDemand's shape). The
// server accepts one call per user per 30 s and a throttled one only returns the market
// status, so nothing here treats it as an error. Returns the market status of both classes
// (closed, opens_at, closes_at), or null before the first answer.
export function useFxFeed(): FeedStatus | null {
  const [status, setStatus] = useState<FeedStatus | null>(null);
  useEffect(() => {
    const supabase = createClient();
    let active = true;
    let timer: ReturnType<typeof setInterval> | null = null;
    const beat = () =>
      void supabase.rpc("request_fx_feed").then(({ data, error }) => {
        if (!active || error) return;
        const next = parseFeedStatus(data);
        if (next) setStatus(next);
      });
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };
    const start = () => {
      stop();
      beat();
      timer = setInterval(beat, FX_FEED_HEARTBEAT_MS);
    };
    const onVisibility = () => (document.visibilityState === "hidden" ? stop() : start());
    if (document.visibilityState !== "hidden") start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      active = false;
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);
  return status;
}

export type FxPosition = {
  id: string;
  instrumentId: string;
  direction: Direction;
  durationS: number;
  premium: bigint;
  fee: bigint;
  entryPrice: string | null; // null while pending
  createdAt: string;
  expiresAt: string | null; // null while pending
  status: "pending" | "open" | "settled" | "void";
  result: "win" | "loss" | "draw" | null;
  settlePrice: string | null;
  payout: bigint | null;
  settledAt: string | null;
};

type PositionRow = {
  id: string;
  instrument_id: string;
  direction: Direction;
  duration_s: number;
  premium_cents: string;
  fee_cents: string;
  entry_price: string | null;
  created_at: string;
  expires_at: string | null;
  status: FxPosition["status"];
  result: FxPosition["result"];
  settle_price: string | null;
  payout_cents: string | null;
  settled_at: string | null;
};

const POSITION_SELECT =
  "id, instrument_id, direction, duration_s, premium_cents::text, fee_cents::text, entry_price::text, created_at, " +
  "expires_at, status, result, settle_price::text, payout_cents::text, settled_at";
export const FX_HISTORY_LIMIT = 50;

function toPosition(r: PositionRow): FxPosition {
  return {
    id: r.id,
    instrumentId: r.instrument_id,
    direction: r.direction,
    durationS: r.duration_s,
    premium: centsFromText(r.premium_cents),
    fee: centsFromText(r.fee_cents),
    entryPrice: r.entry_price,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    status: r.status,
    result: r.result,
    settlePrice: r.settle_price,
    payout: r.payout_cents === null ? null : centsFromText(r.payout_cents),
    settledAt: r.settled_at,
  };
}

type PositionsData = { active: FxPosition[]; history: FxPosition[] };

async function fetchPositions(): Promise<PositionsData | null> {
  const supabase = createClient();
  const [active, history] = await Promise.all([
    supabase
      .from("fx_positions")
      .select(POSITION_SELECT)
      .in("status", ["pending", "open"])
      .order("created_at", { ascending: false })
      .overrideTypes<PositionRow[], { merge: false }>(),
    supabase
      .from("fx_positions")
      .select(POSITION_SELECT)
      .in("status", ["settled", "void"])
      .order("settled_at", { ascending: false })
      .limit(FX_HISTORY_LIMIT)
      .overrideTypes<PositionRow[], { merge: false }>(),
  ]);
  if (active.error || history.error) return null;
  return { active: active.data.map(toPosition), history: history.data.map(toPosition) };
}

// The user's pending and open positions, and the newest settled or void ones, reloaded on
// every change to their rows. reload is latest-wins: only the newest reload may write state.
export function useFxPositions() {
  const [data, setData] = useState<PositionsData | null>(null);
  const [error, setError] = useState(false);
  const latest = useRef(0);

  const reload = useCallback(async () => {
    const ticket = ++latest.current;
    const result = await fetchPositions();
    if (ticket !== latest.current) return;
    setError(result === null);
    if (result) setData(result);
  }, []);

  useEffect(() => {
    const supabase = createClient();
    let channel: ReturnType<typeof supabase.channel> | null = null;
    let active = true;
    supabase.auth.getSession().then(({ data: session }) => {
      const uid = session.session?.user.id;
      if (!uid || !active) return;
      void reload();
      channel = supabase
        .channel(`fx_positions:${crypto.randomUUID()}`)
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "fx_positions", filter: `user_id=eq.${uid}` },
          () => void reload(),
        )
        .subscribe((status) => {
          if (status === "SUBSCRIBED") void reload();
        });
    });
    const stopVisible = onVisible(() => void reload());
    return () => {
      active = false;
      stopVisible();
      if (channel) void supabase.removeChannel(channel);
    };
  }, [reload]);

  return { active: data?.active ?? null, history: data?.history ?? null, error, reload };
}

export type FxRow = { last: PricePoint | null; dayAgo: PricePoint | null };

type TableRow = { instrument_id: string; ts: string; price: string };

// Newest print and the print about a day before it for every listed instrument, in two reads
// (the newest row overall, then everything within 24.5 h of it), with the same dayAgoPrint
// selection as useFxPrice. A burst of Realtime inserts (one per instrument) reloads once.
// Null until the first answer.
export function useFxTable(ids: readonly string[]): Record<string, FxRow> | null {
  const [rows, setRows] = useState<Record<string, FxRow> | null>(null);
  const key = ids.join(",");

  useEffect(() => {
    const list = key ? key.split(",") : [];
    if (list.length === 0) return;
    const supabase = createClient();
    let active = true;
    let ticket = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = async () => {
      const mine = ++ticket;
      const newest = await supabase
        .from("fx_prices")
        .select("ts")
        .in("instrument_id", list)
        .order("ts", { ascending: false })
        .limit(1)
        .overrideTypes<{ ts: string }[], { merge: false }>();
      if (!active || mine !== ticket || newest.error) return;
      if (!newest.data[0]) {
        setRows(Object.fromEntries(list.map((id) => [id, { last: null, dayAgo: null }])));
        return;
      }
      const from = new Date(Date.parse(newest.data[0].ts) - DAY_MS - WINDOW_MS).toISOString();
      const all = await supabase
        .from("fx_prices")
        .select("instrument_id, ts, price::text")
        .in("instrument_id", list)
        .gte("ts", from)
        .order("ts")
        .overrideTypes<TableRow[], { merge: false }>();
      if (!active || mine !== ticket || all.error) return;
      const by = new Map<string, PricePoint[]>(list.map((id) => [id, []]));
      for (const r of all.data) by.get(r.instrument_id)?.push({ ts: r.ts, price: r.price });
      const next: Record<string, FxRow> = {};
      for (const id of list) {
        const own = by.get(id) ?? [];
        const last = own[own.length - 1] ?? null;
        next[id] = { last, dayAgo: last ? dayAgoPrint(own, last.ts) : null };
      }
      setRows(next);
    };
    const soon = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void load(), 300);
    };
    void load();
    const channel = supabase
      .channel(`fx_prices_table:${crypto.randomUUID()}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "fx_prices" }, soon)
      .subscribe((status) => {
        if (status === "SUBSCRIBED") void load();
      });
    const stopVisible = onVisible(() => void load());
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
      stopVisible();
      void supabase.removeChannel(channel);
    };
  }, [key]);

  return rows;
}
