"use server";

import type { LedgerKind } from "@/lib/bills";
import { escapeLike } from "@/lib/escape-like";
import { isGroup, LEDGER_GROUPS } from "@/lib/ledger-groups";
import { createClient } from "@/lib/supabase/server";
import type { Account } from "@/lib/wallets";

const PAGE_SIZE = 50;

export type LedgerEntry = {
  id: string;
  email: string | null;
  account: Account;
  counterAccount: Account | null;
  kind: LedgerKind;
  deltaCents: string;
  note: string | null;
  createdAt: string;
};

export type LedgerPage = { ok: true; rows: LedgerEntry[]; total: number } | { ok: false };

type LedgerRow = {
  id: string;
  account: Account;
  counter_account: Account | null;
  kind: LedgerKind;
  delta_cents: string;
  memo: string | null;
  asset: string | null;
  ref_type: string;
  ref_id: string;
  created_at: string;
  profiles: { email: string | null } | null;
};

const SELECT =
  "id::text, account, counter_account, kind, delta_cents::text, memo, asset, ref_type, ref_id, created_at, profiles!inner(email)";

// One page of the platform ledger, newest first. Runs as the signed-in user:
// RLS lets only a live admin row read other users' rows, and the explicit role
// check below makes a non-admin fail instead of seeing an empty list.
export async function loadLedger(input: { q: string; group: string; offset: number }): Promise<LedgerPage> {
  const offset = Number.isInteger(input.offset) && input.offset >= 0 ? input.offset : 0;
  const supabase = await createClient();

  const { data: auth } = await supabase.auth.getClaims();
  const userId = auth?.claims.sub;
  if (!userId) return { ok: false };
  const { data: role } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "admin")
    .maybeSingle();
  if (!role) return { ok: false };

  let req = supabase
    .from("ledger")
    .select(SELECT, { count: "exact" })
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .range(offset, offset + PAGE_SIZE - 1);
  if (isGroup(input.group)) req = req.in("kind", [...LEDGER_GROUPS[input.group]]);
  const term = input.q.trim().slice(0, 100);
  if (term) req = req.ilike("profiles.email", `%${escapeLike(term)}%`);
  const { data, count, error } = await req.overrideTypes<LedgerRow[], { merge: false }>();
  if (error) return { ok: false };

  // An adjustment's reason lives only in the audit row its ledger row points to.
  const adjustIds = data.filter((r) => r.ref_type === "admin_adjustment").map((r) => r.ref_id);
  const reasons = new Map<string, string | null>();
  if (adjustIds.length > 0) {
    const { data: audits, error: auditError } = await supabase
      .from("admin_audit_log")
      .select("id, reason:payload->>reason")
      .in("id", adjustIds)
      .overrideTypes<{ id: string; reason: string | null }[], { merge: false }>();
    if (auditError) return { ok: false };
    for (const a of audits) reasons.set(a.id, a.reason);
  }

  const rows = data.map((r): LedgerEntry => {
    const note =
      r.ref_type === "admin_adjustment"
        ? (reasons.get(r.ref_id) ?? r.memo)
        : r.asset && (r.kind === "spot_buy" || r.kind === "spot_sell")
          ? `${r.asset}/USDT`
          : r.memo;
    return {
      id: r.id,
      email: r.profiles?.email ?? null,
      account: r.account,
      counterAccount: r.counter_account,
      kind: r.kind,
      deltaCents: r.delta_cents,
      note: note || null,
      createdAt: r.created_at,
    };
  });
  return { ok: true, rows, total: count ?? rows.length };
}
