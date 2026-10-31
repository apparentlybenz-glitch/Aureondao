"use client";

import { useState } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import { Dialog } from "radix-ui";
import { useTranslations } from "next-intl";
import { CoinIcon } from "@/components/market/coin-icon";
import { Button } from "@/components/ui/button";
import { savePref } from "@/lib/preferences";
import { cn } from "@/lib/utils";

export type TradeConfirmRow = { label: string; value: string; tone?: "up" };

type Props = {
  open: boolean;
  title: string;
  base: string; // asset code for the coin icon
  direction: "up" | "down";
  symbolLabel: string;
  badge: string;
  rows: TradeConfirmRow[];
  note: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
};

// The confirmation shown before a Spot or Options order is sent (when the confirmTrades
// preference is on). It only displays values the ticket already computed.
export function TradeConfirm({ open, onCancel, ...props }: Props) {
  return (
    <Dialog.Root open={open} onOpenChange={(next) => (next ? undefined : onCancel())}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60" />
        <Dialog.Content className="fixed top-1/2 left-1/2 z-50 max-h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border bg-popover text-popover-foreground">
          {/* Mounted only while open, so the checkbox starts unticked every time. */}
          <Body {...props} onCancel={onCancel} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Body({
  title,
  base,
  direction,
  symbolLabel,
  badge,
  rows,
  note,
  confirmLabel,
  onConfirm,
  onCancel,
}: Omit<Props, "open">) {
  const t = useTranslations("TradeConfirm");
  const [dontShow, setDontShow] = useState(false);
  const up = direction === "up";
  const Arrow = up ? ArrowUp : ArrowDown;

  return (
    <>
      <Dialog.Title className="border-b px-4 py-3 text-center text-base font-semibold">{title}</Dialog.Title>
      <div className="space-y-4 p-4">
        <div className="flex items-center justify-center gap-3">
          <CoinIcon symbol={base} size={56} />
          <span
            aria-hidden="true"
            data-direction={direction}
            className={cn(
              "trade-confirm-badge flex size-10 items-center justify-center rounded-full",
              up ? "bg-up/15 text-up" : "bg-down/15 text-down",
            )}
          >
            <Arrow className="size-5" />
          </span>
        </div>

        <div className="flex items-center justify-between gap-3 border-t pt-4">
          <span className="font-semibold">{symbolLabel}</span>
          <span
            className={cn(
              "rounded-full border px-2.5 py-0.5 text-xs font-semibold",
              up ? "border-up text-up" : "border-down text-down",
            )}
          >
            {badge}
          </span>
        </div>

        <dl className="space-y-2 text-sm">
          {rows.map((row) => (
            <div key={row.label} className="flex justify-between gap-3">
              <dt className="text-muted-foreground">{row.label}</dt>
              <dd className={cn("font-semibold tabular-nums", row.tone === "up" && "text-up")}>
                {row.tone === "up" ? `+${row.value}` : row.value}
              </dd>
            </div>
          ))}
        </dl>

        <Dialog.Description className="text-xs text-muted-foreground">{note}</Dialog.Description>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={dontShow}
            onChange={(e) => setDontShow(e.target.checked)}
            className="size-4 accent-primary"
          />
          {t("dontShowAgain")}
        </label>

        <div className="space-y-1">
          <Button
            type="button"
            onClick={() => {
              if (dontShow) savePref("confirmTrades", false);
              onConfirm();
            }}
            className={cn(
              "h-11 w-full text-base font-semibold",
              up ? "bg-up text-black hover:bg-up/85" : "bg-down/60 text-white hover:bg-down/70",
            )}
          >
            {confirmLabel}
          </Button>
          <button type="button" onClick={onCancel} className="h-10 w-full text-sm text-muted-foreground">
            {t("cancel")}
          </button>
        </div>
      </div>
    </>
  );
}
