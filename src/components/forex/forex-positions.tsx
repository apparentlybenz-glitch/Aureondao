"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { ForexIcon } from "@/components/forex/forex-icon";
import { LoadingRows } from "@/components/ui/skeleton";
import { durationParts, etStampText, fxDisplay } from "@/lib/forex-math";
import type { FxInstrument, FxPosition } from "@/lib/forex";
import { formatPrice } from "@/lib/market/decimal";
import { formatCents } from "@/lib/money";
import { cn } from "@/lib/utils";

function PositionCard({ p, instrument }: { p: FxPosition; instrument: FxInstrument | undefined }) {
  const t = useTranslations("Forex");
  const rise = p.direction === "rise";
  const price = (v: string | null) => (v === null ? "--" : instrument ? formatPrice(v, instrument.priceDecimals) : v);
  const usd = (v: bigint) => t("usd", { amount: formatCents(v) });
  const d = durationParts(p.durationS);
  const settled = p.status === "settled" || p.status === "void";
  const result = p.status === "void" ? t("result.refunded") : p.result ? t(`result.${p.result}`) : null;
  // Premium, fee and payout are all in cents: PnL is payout minus premium minus fee, and a
  // refund (void) nets to zero.
  const pnl = p.payout === null ? null : p.payout - p.premium - p.fee;

  return (
    <li className="rounded-xl border bg-card p-3 text-sm">
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-2 font-medium">
          <ForexIcon id={p.instrumentId} size="sm" surface="card" />
          <span>{fxDisplay(p.instrumentId)}</span> <span className={rise ? "text-up" : "text-down"}>{t(p.direction)}</span>
        </p>
        {settled ? (
          <span
            className={cn(
              "text-sm font-semibold",
              p.result === "win" ? "text-up" : p.result === "loss" ? "text-down" : "text-muted-foreground",
            )}
          >
            {result}
          </span>
        ) : p.status === "pending" ? (
          <span className="text-sm font-medium text-muted-foreground">{t("waitingEntry")}</span>
        ) : (
          <span className="text-sm font-medium tabular-nums">
            {p.expiresAt ? t("ends", { time: etStampText(p.expiresAt) }) : "--"}
          </span>
        )}
      </div>
      <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs tabular-nums">
        <dt className="text-muted-foreground">{t("field.premium")}</dt>
        <dd className="text-right">{usd(p.premium)}</dd>
        <dt className="text-muted-foreground">{t("field.period")}</dt>
        <dd className="text-right">{t(d.unit, { value: d.value })}</dd>
        <dt className="text-muted-foreground">{t("field.entry")}</dt>
        <dd className="text-right">{price(p.entryPrice)}</dd>
        <dt className="text-muted-foreground">{t("field.fee")}</dt>
        <dd className="text-right">{usd(p.fee)}</dd>
        {settled ? (
          <>
            <dt className="text-muted-foreground">{t("field.settlePrice")}</dt>
            <dd className="text-right">{price(p.settlePrice)}</dd>
            <dt className="text-muted-foreground">{t("field.payout")}</dt>
            <dd className="text-right">{p.payout === null ? "--" : usd(p.payout)}</dd>
            <dt className="text-muted-foreground">{t("field.pnl")}</dt>
            <dd
              className={cn(
                "text-right",
                pnl !== null && pnl > BigInt(0) && "text-up",
                pnl !== null && pnl < BigInt(0) && "text-down",
              )}
            >
              {pnl === null ? "--" : t("usd", { amount: formatCents(pnl, { sign: true }) })}
            </dd>
          </>
        ) : null}
        <dt className="text-muted-foreground">{t("field.opened")}</dt>
        <dd className="text-right">
          <time dateTime={p.createdAt}>{t("et", { time: etStampText(p.createdAt) })}</time>
        </dd>
      </dl>
    </li>
  );
}

// Positions (pending and open) and History (settled and void, newest first), laid out like
// the Options PositionsPanel.
export function ForexPositions({
  active,
  history,
  error,
  instruments,
  currentId,
}: {
  active: FxPosition[] | null;
  history: FxPosition[] | null;
  error: boolean;
  instruments: readonly FxInstrument[];
  currentId: string;
}) {
  const t = useTranslations("Forex");
  const [tab, setTab] = useState<"positions" | "history">("positions");
  const [currentOnly, setCurrentOnly] = useState(false);
  const byId = new Map(instruments.map((i) => [i.id, i]));
  const keep = (list: FxPosition[] | null) =>
    list && currentOnly ? list.filter((p) => p.instrumentId === currentId) : list;
  const shownActive = keep(active);
  const list = tab === "positions" ? shownActive : keep(history);

  return (
    <section className="mt-6">
      <div role="tablist" className="mb-3 flex gap-5 border-b text-sm">
        {(["positions", "history"] as const).map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={cn(
              "press -mb-px border-b-2 py-2",
              tab === key ? "border-primary font-semibold text-foreground" : "border-transparent text-muted-foreground",
            )}
          >
            {key === "positions" ? t("tabs.positions", { count: shownActive?.length ?? 0 }) : t("tabs.history")}
          </button>
        ))}
      </div>
      <label className="mb-3 flex w-fit items-center gap-2 text-sm text-muted-foreground">
        <input
          type="checkbox"
          checked={currentOnly}
          onChange={(e) => setCurrentOnly(e.target.checked)}
          className="size-4 accent-primary"
        />
        {t("currentOnly")}
      </label>

      {error ? <p className="text-sm text-destructive">{t("listError")}</p> : null}
      {list === null ? (
        <LoadingRows label={t("loading")} rows={2} rowClassName="h-16" />
      ) : list.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          {tab === "positions" ? t("noOpen") : t("noHistory")}
        </p>
      ) : (
        <ul className="space-y-2">
          {list.map((p) => (
            <PositionCard key={p.id} p={p} instrument={byId.get(p.instrumentId)} />
          ))}
        </ul>
      )}
    </section>
  );
}
