import type { LedgerKind } from "@/lib/bills";

// The ledger kinds the money RPCs write today, grouped for the admin Audit Log
// pills and badges. Deposit, withdrawal, hold and forex kinds exist in the enum
// but nothing writes them, so they have no group.
export const LEDGER_GROUPS = {
  adjustment: ["admin_credit", "admin_debit"],
  transfer: ["transfer_in", "transfer_out"],
  spot: ["spot_buy", "spot_sell"],
  options: ["option_premium", "option_settle", "option_refund"],
  fee: ["fee"],
} as const satisfies Record<string, readonly LedgerKind[]>;

export type LedgerGroup = keyof typeof LEDGER_GROUPS;

export const GROUPS = Object.keys(LEDGER_GROUPS) as LedgerGroup[];

export function isGroup(value: string): value is LedgerGroup {
  return value in LEDGER_GROUPS;
}

export function groupOf(kind: LedgerKind): LedgerGroup | null {
  return GROUPS.find((g) => (LEDGER_GROUPS[g] as readonly LedgerKind[]).includes(kind)) ?? null;
}
