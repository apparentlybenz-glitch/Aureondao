"use server";

import { isAdmin } from "@/lib/admin-server";
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
  created_at: string;
  profiles: { email: string | null } | null;
};

const SELECT =
  "id::text, account, counter_account, kind, delta_cents::text, memo, asset, created_at, profiles!inner(email)";

// One page of the platform ledger, newest first. Runs as the signed-in user:
// RLS lets only a live admin row read other users' rows, and the explicit role
// check makes a non-admin fail instead of seeing an empty list.
export async function loadLedger(input: { q: string; group: string; offset: number }): Promise<LedgerPage> {
  const offset = Number.isInteger(input.offset) && input.offset >= 0 ? input.offset : 0;
  const supabase = await createClient();

  if (!(await isAdmin(supabase))) return { ok: false };

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

  const rows = data.map((r): LedgerEntry => {
    const note = r.asset && (r.kind === "spot_buy" || r.kind === "spot_sell") ? `${r.asset}/USDT` : r.memo;
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

export type ActionEntry = {
  id: string;
  action: string;
  admin: string | null;
  target: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
};

export type ActionsPage = { ok: true; rows: ActionEntry[]; total: number } | { ok: false };

type AuditRow = {
  id: string;
  admin_id: string | null;
  action: string;
  target_user_id: string | null;
  payload: Record<string, unknown>;
  created_at: string;
};

// One page of admin_audit_log, newest first, with the admin and target emails
// resolved in one batched profiles query.
export async function loadAdminActions(input: { offset: number }): Promise<ActionsPage> {
  const offset = Number.isInteger(input.offset) && input.offset >= 0 ? input.offset : 0;
  const supabase = await createClient();
  if (!(await isAdmin(supabase))) return { ok: false };

  const { data, count, error } = await supabase
    .from("admin_audit_log")
    .select("id, admin_id, action, target_user_id, payload, created_at", { count: "exact" })
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .range(offset, offset + PAGE_SIZE - 1)
    .overrideTypes<AuditRow[], { merge: false }>();
  if (error) return { ok: false };

  const ids = [...new Set(data.flatMap((r) => [r.admin_id, r.target_user_id]).filter((id): id is string => id !== null))];
  const emails = new Map<string, string>();
  if (ids.length > 0) {
    const { data: people, error: peopleError } = await supabase
      .from("profiles")
      .select("id, email, nickname")
      .in("id", ids)
      .overrideTypes<{ id: string; email: string | null; nickname: string }[], { merge: false }>();
    if (peopleError) return { ok: false };
    for (const p of people) emails.set(p.id, p.email ?? p.nickname);
  }

  const who = (id: string | null) => (id ? (emails.get(id) ?? null) : null);
  const rows = data.map(
    (r): ActionEntry => ({
      id: r.id,
      action: r.action,
      admin: who(r.admin_id),
      target: who(r.target_user_id),
      payload: r.payload,
      createdAt: r.created_at,
    }),
  );
  return { ok: true, rows, total: count ?? rows.length };
}
