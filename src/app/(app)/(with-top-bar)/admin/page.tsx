"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { FormError } from "@/components/auth/field";
import { PageHeader } from "@/components/app/page-header";
import { useRpcMessage } from "@/components/app/use-rpc-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAttemptKey } from "@/lib/attempt-key";
import { escapeLike } from "@/lib/escape-like";
import { formatCents, parseAmount, ZERO_CENTS } from "@/lib/money";
import { serverAnswered } from "@/lib/rpc-error";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import { ACCOUNTS, type Account, toWallets, type Wallet, WALLET_SELECT } from "@/lib/wallets";

// UX gate only. The real boundary is in SQL: RLS admin reads and
// admin_adjust_balance both require the admin row and aal2.
type Gate = "loading" | "not_admin" | "step_up" | "needs_factor" | "ok";

type UserRow = { id: string; uid: string; email: string | null; nickname: string };

const selectClass =
  "h-11 w-full rounded-lg border border-input bg-transparent px-3 text-base outline-none focus-visible:ring-3 focus-visible:ring-ring/50";

export default function AdminPage() {
  const t = useTranslations("Admin");
  const [gate, setGate] = useState<Gate>("loading");

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getClaims().then(async ({ data }) => {
      const claims = data?.claims;
      if (claims?.user_role !== "admin") return setGate("not_admin");
      if (claims.aal === "aal2") return setGate("ok");
      const { data: factors } = await supabase.auth.mfa.listFactors();
      setGate(factors?.totp.some((f) => f.status === "verified") ? "step_up" : "needs_factor");
    });
  }, []);

  return (
    <div className="space-y-5">
      <PageHeader title={t("title")} />
      {gate === "not_admin" ? <p className="text-sm text-muted-foreground">{t("needAdmin")}</p> : null}
      {gate === "step_up" || gate === "needs_factor" ? <StepUp hasFactor={gate === "step_up"} /> : null}
      {gate === "ok" ? <AdminConsole /> : null}
    </div>
  );
}

function StepUp({ hasFactor }: { hasFactor: boolean }) {
  const t = useTranslations("Admin");
  return (
    <div className="space-y-3 rounded-xl border bg-card p-4">
      <p className="font-medium">{t("stepUpTitle")}</p>
      <p className="text-sm text-muted-foreground">{hasFactor ? t("stepUpBody") : t("setUpTotp")}</p>
      <Button asChild className="h-11 w-full">
        {hasFactor ? (
          <Link href={`/sign-in/mfa?next=${encodeURIComponent("/admin")}`}>{t("stepUp")}</Link>
        ) : (
          <Link href="/account/security">{t("toSecurity")}</Link>
        )}
      </Button>
    </div>
  );
}

async function fetchUsers(q: string): Promise<UserRow[]> {
  let req = createClient()
    .from("profiles")
    .select("id, uid::text, email, nickname")
    .order("created_at", { ascending: false })
    .limit(50);
  const term = q.trim();
  if (/^\d{8}$/.test(term)) req = req.eq("uid", term);
  else if (term) req = req.ilike("email", `%${escapeLike(term)}%`);
  const { data } = await req.overrideTypes<UserRow[], { merge: false }>();
  return data ?? [];
}

function AdminConsole() {
  const t = useTranslations("Admin");
  const c = useTranslations("Common");
  const [query, setQuery] = useState("");
  const [users, setUsers] = useState<UserRow[] | null>(null);
  const [selected, setSelected] = useState<UserRow | null>(null);

  useEffect(() => {
    let active = true;
    fetchUsers("").then((rows) => {
      if (active) setUsers(rows);
    });
    return () => {
      active = false;
    };
  }, []);

  return (
    <div className="space-y-5">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void fetchUsers(query).then(setUsers);
        }}
        className="flex gap-2"
      >
        <Input
          aria-label={t("search")}
          placeholder={t("search")}
          className="h-11 text-base"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <Button type="submit" variant="secondary" className="h-11">
          {t("users")}
        </Button>
      </form>

      {users === null ? <p className="text-sm">{c("loading")}</p> : null}
      {users?.length === 0 ? <p className="text-sm text-muted-foreground">{t("noUsers")}</p> : null}
      <ul className="space-y-2">
        {users?.map((u) => (
          <li key={u.id}>
            <button
              type="button"
              onClick={() => setSelected(u)}
              className={cn(
                "w-full rounded-xl border p-3 text-left",
                selected?.id === u.id ? "border-foreground" : "",
              )}
            >
              <p className="text-sm font-medium">
                {u.nickname} <span className="font-mono text-xs text-muted-foreground">{u.uid}</span>
              </p>
              <p className="truncate text-xs text-muted-foreground">{u.email}</p>
            </button>
          </li>
        ))}
      </ul>

      {selected ? <AdjustForm key={selected.id} user={selected} /> : <p className="text-sm text-muted-foreground">{t("selectUser")}</p>}
    </div>
  );
}

async function fetchWallets(userId: string): Promise<Wallet[] | null> {
  const { data } = await createClient()
    .from("wallets")
    .select(WALLET_SELECT)
    .eq("user_id", userId)
    .overrideTypes<{ account: Account; available_cents: string; held_cents: string }[], { merge: false }>();
  return data ? toWallets(data) : null;
}

function AdjustForm({ user }: { user: UserRow }) {
  const t = useTranslations("Admin");
  const w = useTranslations("Wallets");
  const tr = useTranslations("Transfer");
  const rpcMessage = useRpcMessage();
  const attempt = useAttemptKey();
  const [wallets, setWallets] = useState<Wallet[] | null>(null);
  const [account, setAccount] = useState<Account>("capital");
  const [direction, setDirection] = useState<"credit" | "debit">("credit");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const loadWallets = useCallback(() => {
    fetchWallets(user.id).then(setWallets);
  }, [user.id]);

  useEffect(() => {
    let active = true;
    fetchWallets(user.id).then((rows) => {
      if (active) setWallets(rows);
    });
    return () => {
      active = false;
    };
  }, [user.id]);

  const cents = parseAmount(amount);
  const reasonOk = reason.trim().length >= 3 && reason.length <= 200;
  const canSubmit = !pending && cents !== null && cents > ZERO_CENTS && reasonOk;

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!canSubmit || cents === null) return;
    const delta = direction === "credit" ? cents : -cents;
    setPending(true);
    setError(null);
    setDone(null);
    const key = attempt.keyFor(`${user.id}|${account}|${delta}|${reason}`);
    const { error } = await createClient().rpc("admin_adjust_balance", {
      p_user_id: user.id,
      p_account: account,
      p_delta_cents: delta.toString(),
      p_reason: reason,
      p_client_request_id: key,
    });
    setPending(false);
    if (error) {
      if (serverAnswered(error)) attempt.settle();
      setError(rpcMessage(error));
      return;
    }
    attempt.settle();
    setDone(t("done", { amount: formatCents(delta, { sign: true }), wallet: w(account) }));
    setAmount("");
    setReason("");
    loadWallets();
  }

  return (
    <section className="space-y-4 rounded-xl border bg-card p-4">
      <h2 className="font-medium">{t("adjustTitle")}</h2>
      <div>
        <p className="mb-1 text-xs text-muted-foreground">{t("balances")}</p>
        <ul className="grid grid-cols-2 gap-2 text-sm">
          {(wallets ?? []).map((x) => (
            <li key={x.account} className="rounded-lg bg-muted px-3 py-2">
              <span className="block text-xs text-muted-foreground">{w(x.account)}</span>
              <span className="tabular-nums">{formatCents(x.available)}</span>
            </li>
          ))}
        </ul>
      </div>

      <form onSubmit={onSubmit} className="space-y-4">
        <div className="grid grid-cols-2 gap-2">
          {(["credit", "debit"] as const).map((d) => (
            <Button
              key={d}
              type="button"
              variant={direction === d ? "default" : "secondary"}
              className="h-11"
              aria-pressed={direction === d}
              onClick={() => setDirection(d)}
            >
              {t(d)}
            </Button>
          ))}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="wallet">{t("wallet")}</Label>
          <select id="wallet" className={selectClass} value={account} onChange={(e) => setAccount(e.target.value as Account)}>
            {ACCOUNTS.map((acc) => (
              <option key={acc} value={acc}>
                {w(acc)}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="amount">{t("amount")}</Label>
          <Input
            id="amount"
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.00"
            className="h-11 text-base"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
          <FormError message={amount !== "" && (cents === null || cents <= ZERO_CENTS) ? tr("invalidAmount") : null} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="reason">{t("reason")}</Label>
          <Input
            id="reason"
            maxLength={200}
            className="h-11 text-base"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
        <FormError message={error} />
        {done ? (
          <p role="status" className="text-sm text-emerald-500">
            {done}
          </p>
        ) : null}
        <Button type="submit" className="h-11 w-full" disabled={!canSubmit}>
          {pending ? t("sending") : t("submit")}
        </Button>
      </form>
    </section>
  );
}
