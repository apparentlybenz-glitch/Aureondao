"use client";

import { useEffect, useState } from "react";
import { balanceSeries, HISTORY_DAYS, type LedgerPoint, type SeriesPoint } from "@/lib/balance-series";
import { createClient } from "@/lib/supabase/client";
import { ACCOUNTS } from "@/lib/wallets";

const SELECT = "account, balance_after_cents::text, held_after_cents::text, created_at";
const PAGE = 1000;
const DAY_MS = 86_400_000;

type Rows = { since: number; starts: LedgerPoint[]; rows: LedgerPoint[] };

// Read only. Every query filters by the own user id: an admin's RLS read covers
// every user's ledger, so RLS alone would mix other accounts in.
async function fetchRows(): Promise<Rows | null> {
  const supabase = createClient();
  const { data: session } = await supabase.auth.getSession();
  const uid = session.session?.user.id;
  if (!uid) return null;
  const since = Date.now() - HISTORY_DAYS * DAY_MS;
  const sinceIso = new Date(since).toISOString();
  const starts = await Promise.all(
    ACCOUNTS.map((account) =>
      supabase
        .from("ledger")
        .select(SELECT)
        .eq("user_id", uid)
        .eq("account", account)
        .lt("created_at", sinceIso)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(1)
        .maybeSingle()
        .overrideTypes<LedgerPoint, { merge: false }>(),
    ),
  );
  if (starts.some((r) => r.error)) return null;
  const rows: LedgerPoint[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("ledger")
      .select(SELECT)
      .eq("user_id", uid)
      .gte("created_at", sinceIso)
      .order("created_at")
      .order("id")
      .range(from, from + PAGE - 1)
      .overrideTypes<LedgerPoint[], { merge: false }>();
    if (error) return null;
    rows.push(...data);
    if (data.length < PAGE) break;
  }
  return { since, starts: starts.flatMap((r) => (r.data ? [r.data] : [])), rows };
}

// The total over the last 7 days, ending at now with `current` (the displayed total).
// Refetches when the current total changes, since that means new ledger rows.
// Null while loading or when current is unknown; a failed read draws a flat line.
export function useBalanceHistory(current: bigint | null): SeriesPoint[] | null {
  const [data, setData] = useState<{ rows: Rows | null; at: number } | null>(null);
  const key = current === null ? null : current.toString();

  useEffect(() => {
    if (key === null) return;
    let active = true;
    void fetchRows()
      .catch(() => null)
      .then((rows) => {
        if (active) setData({ rows, at: Date.now() });
      });
    return () => {
      active = false;
    };
  }, [key]);

  if (current === null || !data) return null;
  // The line ends when the rows were read; current is the live total.
  if (!data.rows) return balanceSeries([], [], data.at - HISTORY_DAYS * DAY_MS, data.at, current);
  return balanceSeries(data.rows.starts, data.rows.rows, data.rows.since, data.at, current);
}
