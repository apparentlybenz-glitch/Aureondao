"use client";

import { useTranslations } from "next-intl";
import type { Account } from "@/lib/wallets";

// Bills rows as read from `ledger` (own rows for a user, any user's for an admin).
export type LedgerKind =
  | "transfer_in" | "transfer_out" | "deposit" | "withdrawal_hold" | "withdrawal_release"
  | "withdrawal_paid" | "admin_credit" | "admin_debit" | "order_hold" | "order_release"
  | "spot_buy" | "spot_sell" | "forex_margin" | "forex_close" | "option_premium"
  | "option_settle" | "fee" | "option_refund";

export type BillRow = {
  id: string;
  account: Account;
  kind: LedgerKind;
  counter_account: Account | null;
  delta_cents: string;
  memo: string | null;
  created_at: string;
};

export const BILL_SELECT = "id::text, account, kind, counter_account, delta_cents::text, memo, created_at";

// The second line of a Bills row: the memo when there is one, else the transfer
// route or the kind label. Text comes from en.json, never from the database.
export function useBillDescription() {
  const t = useTranslations("Bills");
  const w = useTranslations("Wallets");
  return (row: BillRow): string => {
    if (row.memo) return row.memo;
    if (row.counter_account && row.kind === "transfer_out") {
      return t("transfer", { from: w(row.account), to: w(row.counter_account) });
    }
    if (row.counter_account && row.kind === "transfer_in") {
      return t("transfer", { from: w(row.counter_account), to: w(row.account) });
    }
    return t(`kind.${row.kind}`);
  };
}
