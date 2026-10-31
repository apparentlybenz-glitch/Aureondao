"use client";

import { useCallback, useEffect, useState } from "react";
import { centsFromText } from "@/lib/money";
import { onVisible } from "@/lib/on-visible";
import { serverNowMs } from "@/lib/server-clock";
import { createClient } from "@/lib/supabase/client";

// One reload this long after a position expires, in case its Realtime update was missed.
const SETTLE_RELOAD_MS = 12_000;

// Options reads (RLS: periods for any signed-in user, positions own rows only).
// Numeric and bigint columns are selected as text (hard rule 1). Both tables are
// in the Realtime publication; every channel name gets a random suffix (rule 7).
export type Direction = "rise" | "fall";

export type OptionPeriod = {
  durationS: number;
  profitRateBps: number;
  feeBps: number;
  minPremium: bigint;
  enabled: boolean;
};

export type OptionPosition = {
  id: string;
  marketId: string;
  direction: Direction;
  durationS: number;
  premium: bigint;
  fee: bigint;
  entryPrice: string;
  createdAt: string;
  expiresAt: number; // epoch ms, server time
  status: "open" | "settled" | "void";
  result: "win" | "loss" | "draw" | null;
  settlePrice: string | null;
  payout: bigint | null;
  settledAt: string | null;
};

type PeriodRow = {
  duration_s: number;
  profit_rate_bps: number;
  fee_bps: number;
  min_premium_cents: string;
  enabled: boolean;
};

type PositionRow = {
  id: string;
  market_id: string;
  direction: Direction;
  duration_s: number;
  premium_cents: string;
  fee_cents: string;
  entry_price: string;
  created_at: string;
  expires_at: string;
  status: OptionPosition["status"];
  result: OptionPosition["result"];
  settle_price: string | null;
  payout_cents: string | null;
  settled_at: string | null;
};

const PERIOD_SELECT = "duration_s, profit_rate_bps, fee_bps, min_premium_cents::text, enabled";
const POSITION_SELECT =
  "id, market_id, direction, duration_s, premium_cents::text, fee_cents::text, entry_price::text, created_at, " +
  "expires_at, status, result, settle_price::text, payout_cents::text, settled_at";
export const FILL_LIMIT = 50;

function toPosition(r: PositionRow): OptionPosition {
  return {
    id: r.id,
    marketId: r.market_id,
    direction: r.direction,
    durationS: r.duration_s,
    premium: centsFromText(r.premium_cents),
    fee: centsFromText(r.fee_cents),
    entryPrice: r.entry_price,
    createdAt: r.created_at,
    expiresAt: Date.parse(r.expires_at),
    status: r.status,
    result: r.result,
    settlePrice: r.settle_price,
    payout: r.payout_cents === null ? null : centsFromText(r.payout_cents),
    settledAt: r.settled_at,
  };
}

// All periods in duration order, kept live (admin edits arrive over Realtime).
export function useOptionPeriods(): OptionPeriod[] | null {
  const [periods, setPeriods] = useState<OptionPeriod[] | null>(null);

  useEffect(() => {
    const supabase = createClient();
    let active = true;
    const load = async () => {
      const { data, error } = await supabase
        .from("option_periods")
        .select(PERIOD_SELECT)
        .order("duration_s")
        .overrideTypes<PeriodRow[], { merge: false }>();
      if (!active || error) return;
      setPeriods(
        data.map((r) => ({
          durationS: r.duration_s,
          profitRateBps: r.profit_rate_bps,
          feeBps: r.fee_bps,
          minPremium: centsFromText(r.min_premium_cents),
          enabled: r.enabled,
        })),
      );
    };
    void load();
    const channel = supabase
      .channel(`option_periods:${crypto.randomUUID()}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "option_periods" }, () => void load())
      .subscribe((status) => {
        if (status === "SUBSCRIBED") void load();
      });
    const stopVisible = onVisible(() => void load());
    return () => {
      active = false;
      stopVisible();
      void supabase.removeChannel(channel);
    };
  }, []);

  return periods;
}

type PositionsData = { open: OptionPosition[]; fills: OptionPosition[] };

async function fetchPositions(): Promise<PositionsData | null> {
  const supabase = createClient();
  const [open, fills] = await Promise.all([
    supabase
      .from("options_positions")
      .select(POSITION_SELECT)
      .eq("status", "open")
      .order("expires_at")
      .overrideTypes<PositionRow[], { merge: false }>(),
    supabase
      .from("options_positions")
      .select(POSITION_SELECT)
      .neq("status", "open")
      .order("settled_at", { ascending: false })
      .limit(FILL_LIMIT)
      .overrideTypes<PositionRow[], { merge: false }>(),
  ]);
  if (open.error || fills.error) return null;
  return { open: open.data.map(toPosition), fills: fills.data.map(toPosition) };
}

// The user's open positions and newest settled or void ones, reloaded on every
// change to their rows (open, settle, void).
export function useOptionPositions() {
  const [data, setData] = useState<PositionsData | null>(null);
  const [error, setError] = useState(false);

  const reload = useCallback(async () => {
    const result = await fetchPositions();
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
        .channel(`options_positions:${crypto.randomUUID()}`)
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "options_positions", filter: `user_id=eq.${uid}` },
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

  // Settlement normally arrives over Realtime. If that event is missed, reload
  // once shortly after each position expires, so "Settling" never sticks.
  const open = data?.open;
  useEffect(() => {
    if (!open?.length) return;
    const timers = open.map((p) =>
      setTimeout(() => void reload(), Math.max(p.expiresAt + SETTLE_RELOAD_MS - serverNowMs(), 0)),
    );
    return () => timers.forEach(clearTimeout);
  }, [open, reload]);

  return { open: data?.open ?? null, fills: data?.fills ?? null, error, reload };
}
