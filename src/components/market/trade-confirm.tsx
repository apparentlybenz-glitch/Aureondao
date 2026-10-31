"use client";

import { useState } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import { Dialog } from "radix-ui";
import { AnimatePresence, MotionConfig, motion, useIsPresent } from "motion/react";
import { useTranslations } from "next-intl";
import { CoinIcon } from "@/components/market/coin-icon";
import { Button } from "@/components/ui/button";
import { saveConfirmTrades } from "@/lib/preferences";
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

// Mirrors --ease-out-strong in globals.css (motion takes the curve as numbers).
const EASE_OUT = [0.23, 1, 0.32, 1] as const;

// Enter: a critically damped spring (no overshoot) on the card, a quick fade on the scrim.
// Exit is shorter. Only opacity and transform animate; the card starts near full size.
const backdropMotion = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: 0.2, ease: EASE_OUT } },
  exit: { opacity: 0, transition: { duration: 0.12, ease: EASE_OUT } },
};
const cardMotion = {
  initial: { opacity: 0, transform: "scale(0.96)" },
  animate: {
    opacity: 1,
    transform: "scale(1)",
    transition: {
      opacity: { duration: 0.2, ease: EASE_OUT },
      transform: { type: "spring" as const, bounce: 0, duration: 0.3 },
    },
  },
  exit: {
    opacity: 0,
    transform: "scale(0.98)",
    transition: { duration: 0.15, ease: EASE_OUT },
  },
};

// The confirmation shown before a Spot or Options order is sent (when the confirmTrades
// preference is on). It only displays values the ticket already computed. The parent sets
// `open` false and AnimatePresence keeps the node until the exit finishes; nothing in the
// order path waits on it. Reduced motion falls back to a fade (opacity only).
export function TradeConfirm({ open, onCancel, ...props }: Props) {
  return (
    <MotionConfig reducedMotion="user">
      <Dialog.Root open={open} onOpenChange={(next) => (next || !open ? undefined : onCancel())}>
        <AnimatePresence>
          {open ? (
            <Dialog.Portal forceMount>
              <Dialog.Overlay forceMount asChild>
                <motion.div className="fixed inset-0 z-50 bg-black/60" {...backdropMotion} />
              </Dialog.Overlay>
              <Dialog.Content
                forceMount
                asChild
              >
                <motion.div
                  className="fixed top-1/2 left-1/2 z-50 max-h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border bg-popover text-popover-foreground"
                  style={{ transformOrigin: "center" }}
                  {...cardMotion}
                >
                  {/* Mounted only while open, so the checkbox starts unticked every time. */}
                  <Body {...props} onCancel={onCancel} />
                </motion.div>
              </Dialog.Content>
            </Dialog.Portal>
          ) : null}
        </AnimatePresence>
      </Dialog.Root>
    </MotionConfig>
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
  // False while the exit plays: the card ignores taps so Confirm cannot fire twice.
  const present = useIsPresent();
  const up = direction === "up";
  const Arrow = up ? ArrowUp : ArrowDown;

  return (
    <>
      <Dialog.Title className="border-b px-4 py-3 text-center text-base font-semibold">{title}</Dialog.Title>
      <div className="space-y-4 p-4" inert={!present}>
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
              // Not awaited: the order never waits on the preference. If the save fails the
              // dialog simply shows again next time.
              if (dontShow) void saveConfirmTrades(false);
              onConfirm();
            }}
            className={cn(
              "h-11 w-full text-base font-semibold duration-150 ease-out-strong active:scale-[0.97]",
              up ? "bg-up text-black hover:bg-up/85" : "bg-down/60 text-white hover:bg-down/70",
            )}
          >
            {confirmLabel}
          </Button>
          <button type="button" onClick={onCancel} className="h-10 w-full text-sm text-muted-foreground transition-transform duration-150 ease-out-strong active:scale-[0.97]"
          >
            {t("cancel")}
          </button>
        </div>
      </div>
    </>
  );
}
