import { escapeLike } from "@/lib/escape-like";
import { BILL_SELECT, type BillRow } from "@/lib/bills";
import { createClient } from "@/lib/supabase/client";
import { type Account, toWallets, type Wallet, WALLET_SELECT } from "@/lib/wallets";

// Admin reads. The browser reads these tables under RLS: private.is_admin()
// needs the live admin row, so a non-admin gets no rows at all.
export type AdminUser = {
  id: string;
  uid: string;
  email: string | null;
  nickname: string;
  suspended_at: string | null;
  suspension_reason: string | null;
};

const USER_SELECT = "id, uid::text, email, nickname, suspended_at, suspension_reason";
const SEARCH_LIMIT = 50;
export const BILLS_LIMIT = 20;

// Email substring (escaped ilike) or an exact 8-digit UID; empty lists the newest users.
// Every read returns null when the request failed.
export async function searchUsers(q: string): Promise<AdminUser[] | null> {
  let req = createClient()
    .from("profiles")
    .select(USER_SELECT)
    .order("created_at", { ascending: false })
    .limit(SEARCH_LIMIT);
  const term = q.trim();
  if (/^\d{8}$/.test(term)) req = req.eq("uid", term);
  else if (term) req = req.ilike("email", `%${escapeLike(term)}%`);
  const { data, error } = await req.overrideTypes<AdminUser[], { merge: false }>();
  return error ? null : data;
}

export async function fetchUser(id: string): Promise<AdminUser | null> {
  const { data } = await createClient()
    .from("profiles")
    .select(USER_SELECT)
    .eq("id", id)
    .maybeSingle()
    .overrideTypes<AdminUser, { merge: false }>();
  return data;
}

// The user_roles admin row. RLS lets an admin read any row, and a user read their
// own. Null when the read failed; no row is a plain user.
export type AdminRole = { isAdmin: boolean; isHead: boolean; isOwner: boolean };

export async function fetchAdminRole(userId: string): Promise<AdminRole | null> {
  const { data, error } = await createClient()
    .from("user_roles")
    .select("is_head, is_owner")
    .eq("user_id", userId)
    .eq("role", "admin")
    .maybeSingle()
    .overrideTypes<{ is_head: boolean; is_owner: boolean }, { merge: false }>();
  return error ? null : { isAdmin: data !== null, isHead: data?.is_head === true, isOwner: data?.is_owner === true };
}

export async function fetchWallets(userId: string): Promise<Wallet[] | null> {
  const { data, error } = await createClient()
    .from("wallets")
    .select(WALLET_SELECT)
    .eq("user_id", userId)
    .overrideTypes<{ account: Account; available_cents: string; held_cents: string }[], { merge: false }>();
  return error ? null : toWallets(data);
}

export async function fetchRecentBills(userId: string): Promise<BillRow[] | null> {
  const { data, error } = await createClient()
    .from("ledger")
    .select(BILL_SELECT)
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(BILLS_LIMIT)
    .overrideTypes<BillRow[], { merge: false }>();
  return error ? null : data;
}
