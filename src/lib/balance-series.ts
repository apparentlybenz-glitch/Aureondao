// The Overview sparkline: total balance over a fixed window, built from ledger rows.
// Each ledger row carries its wallet's balance after the change (available and held),
// so the total at any moment is the sum over wallets of their latest row so far.

export type LedgerPoint = {
  account: string;
  balance_after_cents: string;
  held_after_cents: string;
  created_at: string;
};

export type SeriesPoint = { t: number; cents: bigint };

export const HISTORY_DAYS = 7;

// starts: per wallet, the latest row before the window (a wallet with none was at 0).
// rows: every row inside the window, ordered by created_at then id.
// The series begins at the window start, steps at each instant (a point with the old total
// and one with the new, at the same instant) and ends at now with the current total,
// the same value the balance display shows. No rows at all gives a flat line.
export function balanceSeries(
  starts: LedgerPoint[],
  rows: LedgerPoint[],
  since: number,
  now: number,
  current: bigint,
): SeriesPoint[] {
  const byWallet = new Map<string, bigint>();
  const after = (r: LedgerPoint) => BigInt(r.balance_after_cents) + BigInt(r.held_after_cents);
  const sum = () => [...byWallet.values()].reduce((a, b) => a + b, BigInt(0));
  for (const r of starts) byWallet.set(r.account, after(r));
  if (starts.length === 0 && rows.length === 0) {
    return [
      { t: since, cents: current },
      { t: now, cents: current },
    ];
  }
  const points: SeriesPoint[] = [{ t: since, cents: sum() }];
  // Rows written at the same instant (both legs of a transfer, a trade and its fee)
  // share created_at and apply as one step, so no half-applied total is drawn.
  for (let i = 0; i < rows.length; ) {
    const at = rows[i].created_at;
    const t = Math.min(Math.max(Date.parse(at), since), now);
    points.push({ t, cents: sum() });
    for (; i < rows.length && rows[i].created_at === at; i++) byWallet.set(rows[i].account, after(rows[i]));
    points.push({ t, cents: sum() });
  }
  points.push({ t: now, cents: sum() }, { t: now, cents: current });
  return points;
}
