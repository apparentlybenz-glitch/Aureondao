"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { FormError } from "@/components/auth/field";
import { AdminHeading } from "@/components/admin/admin-heading";
import { SelectedUserCard, useSelectedUser, UserSearch } from "@/components/admin/selected-user";
import { useRpcMessage } from "@/components/app/use-rpc-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { type AdminUser, fetchWallets } from "@/lib/admin";
import { useAttemptKey } from "@/lib/attempt-key";
import { formatCents, parseAmount, ZERO_CENTS } from "@/lib/money";
import { serverAnswered } from "@/lib/rpc-error";
import { createClient } from "@/lib/supabase/client";
import { ACCOUNTS, type Account, type Wallet } from "@/lib/wallets";

const selectClass =
  "h-11 w-full rounded-lg border border-input bg-input px-3 text-base outline-none focus-visible:ring-3 focus-visible:ring-ring/50";

export default function TopUpPage() {
  const t = useTranslations("Admin");
  const { user, select } = useSelectedUser();
  return (
    <>
      <AdminHeading title={t("sections.topUp")} description={t("topUp.description")} />
      {user ? (
        <div className="space-y-5">
          <SelectedUserCard user={user} onChange={() => select(null)} changeLabel={t("topUp.change")} />
          <AdjustForm key={user.id} user={user} />
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">{t("topUp.pickUser")}</p>
          <UserSearch onPick={select} />
        </div>
      )}
    </>
  );
}

function AdjustForm({ user }: { user: AdminUser }) {
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
    if (error) {
      setPending(false);
      // Without a server answer the adjustment may have run: keep the key so a
      // retry of this attempt cannot apply it twice.
      if (serverAnswered(error)) attempt.settle();
      setError(rpcMessage(error));
      return;
    }
    attempt.settle();
    const fresh = await fetchWallets(user.id);
    setPending(false);
    if (fresh) setWallets(fresh);
    const balance = fresh?.find((x) => x.account === account);
    setDone(
      t("topUp.done", {
        amount: formatCents(delta, { sign: true }),
        wallet: w(account),
        balance: balance ? formatCents(balance.available) : "--",
      }),
    );
    setAmount("");
    setReason("");
  }

  return (
    <section className="space-y-4 rounded-xl border bg-card p-4">
      <div>
        <p className="mb-1 text-xs text-muted-foreground">{t("topUp.balances")}</p>
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
              {t(`topUp.${d}`)}
            </Button>
          ))}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="topup-wallet">{t("topUp.wallet")}</Label>
          <select id="topup-wallet" className={selectClass} value={account} onChange={(e) => setAccount(e.target.value as Account)}>
            {ACCOUNTS.map((acc) => (
              <option key={acc} value={acc}>
                {w(acc)}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="topup-amount">{t("topUp.amount")}</Label>
          <Input
            id="topup-amount"
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
          <Label htmlFor="topup-reason">{t("topUp.reason")}</Label>
          <Input
            id="topup-reason"
            maxLength={200}
            className="h-11 text-base"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
        <FormError message={error} />
        {done ? (
          <p role="status" className="text-sm text-up">
            {done}
          </p>
        ) : null}
        <Button type="submit" className="h-11 w-full" disabled={!canSubmit}>
          {pending ? t("topUp.sending") : t("topUp.submit")}
        </Button>
      </form>
    </section>
  );
}
