"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowUpDown } from "lucide-react";
import { useTranslations } from "next-intl";
import { FormError } from "@/components/auth/field";
import { PageHeader } from "@/components/app/page-header";
import { useRpcMessage } from "@/components/app/use-rpc-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAttemptKey } from "@/lib/attempt-key";
import { centsToInput, formatCents, parseAmount, ZERO_CENTS } from "@/lib/money";
import { serverAnswered } from "@/lib/rpc-error";
import { createClient } from "@/lib/supabase/client";
import { ACCOUNTS, type Account, useWallets } from "@/lib/wallets";

const selectClass =
  "h-11 w-full rounded-lg border border-input bg-transparent px-3 text-base outline-none focus-visible:ring-3 focus-visible:ring-ring/50";

export default function TransferPage() {
  const t = useTranslations("Transfer");
  const w = useTranslations("Wallets");
  const a = useTranslations("Assets");
  const rpcMessage = useRpcMessage();
  const { wallets, reload } = useWallets();
  const attempt = useAttemptKey();

  const [from, setFrom] = useState<Account>("capital");
  const [to, setTo] = useState<Account>("spot");
  const [amount, setAmount] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const available = wallets?.find((x) => x.account === from)?.available ?? ZERO_CENTS;
  const cents = parseAmount(amount);
  const amountError =
    amount === "" ? null : cents === null || cents <= ZERO_CENTS ? t("invalidAmount") : cents > available ? t("overBalance") : null;
  const canSubmit = !pending && wallets !== null && cents !== null && cents > ZERO_CENTS && cents <= available;

  // Picking the other side's wallet swaps them, so both sides never match.
  function pickFrom(next: Account) {
    if (next === to) setTo(from);
    setFrom(next);
    setSuccess(null);
  }
  function pickTo(next: Account) {
    if (next === from) setFrom(to);
    setTo(next);
    setSuccess(null);
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!canSubmit || cents === null) return;
    setPending(true);
    setError(null);
    setSuccess(null);
    const key = attempt.keyFor(`${from}|${to}|${cents}`);
    const { error } = await createClient().rpc("transfer_between_wallets", {
      p_from: from,
      p_to: to,
      p_amount_cents: cents.toString(),
      p_client_request_id: key,
    });
    setPending(false);
    if (error) {
      // Without a server answer the transfer may have run: keep the key so a
      // retry of this attempt cannot move the money twice.
      if (serverAnswered(error)) attempt.settle();
      setError(rpcMessage(error));
      return;
    }
    attempt.settle();
    setSuccess(t("success", { amount: formatCents(cents), from: w(from), to: w(to) }));
    setAmount("");
    void reload();
  }

  return (
    <div className="space-y-5">
      <PageHeader title={t("title")} back="/assets" />
      <p className="text-sm text-muted-foreground">{t("note")}</p>

      <form onSubmit={onSubmit} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="from">{t("from")}</Label>
          <select id="from" className={selectClass} value={from} onChange={(e) => pickFrom(e.target.value as Account)}>
            {ACCOUNTS.map((acc) => (
              <option key={acc} value={acc}>
                {w(acc)}
              </option>
            ))}
          </select>
        </div>

        <div className="flex justify-center">
          <Button
            type="button"
            variant="secondary"
            size="icon-lg"
            aria-label={t("swap")}
            className="rounded-full"
            onClick={() => {
              setFrom(to);
              setTo(from);
              setSuccess(null);
            }}
          >
            <ArrowUpDown />
          </Button>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="to">{t("to")}</Label>
          <select id="to" className={selectClass} value={to} onChange={(e) => pickTo(e.target.value as Account)}>
            {ACCOUNTS.filter((acc) => acc !== from).map((acc) => (
              <option key={acc} value={acc}>
                {w(acc)}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="amount">{t("amount")}</Label>
          <div className="flex gap-2">
            <Input
              id="amount"
              inputMode="decimal"
              autoComplete="off"
              placeholder="0.00"
              className="h-11 text-base"
              value={amount}
              aria-invalid={amountError ? true : undefined}
              onChange={(e) => {
                setAmount(e.target.value);
                setSuccess(null);
              }}
            />
            <Button type="button" variant="secondary" className="h-11 px-4" onClick={() => setAmount(centsToInput(available))}>
              {t("max")}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground tabular-nums">
            {t("available", { amount: formatCents(available) })}
          </p>
          <FormError message={amountError} />
        </div>

        <FormError message={error} />
        {success ? (
          <p role="status" className="text-sm text-emerald-500">
            {success}
          </p>
        ) : null}

        <Button type="submit" className="h-11 w-full" disabled={!canSubmit}>
          {pending ? t("sending") : t("confirm")}
        </Button>
      </form>
      <Link href="/assets/bills" className="block text-center text-sm underline">
        {a("bills")}
      </Link>
    </div>
  );
}
