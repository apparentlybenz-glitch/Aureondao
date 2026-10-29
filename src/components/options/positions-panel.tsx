"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { formatPrice } from "@/lib/market/decimal";
import type { Market } from "@/lib/market/types";
import { formatCents } from "@/lib/money";
import { formatCountdown } from "@/lib/options-math";
import type { OptionPosition } from "@/lib/options";
import { useServerNow } from "@/lib/server-clock";
import { cn } from "@/lib/utils";

const timeFormat = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "medium" });

// Counts down to the server's expires_at with the shared server clock. At zero
// it reads "Settling" until the Realtime update moves the row to Fill.
function Countdown({ expiresAt }: { expiresAt: number }) {
  const t = useTranslations("Options");
  const now = useServerNow();
  const left = expiresAt - now;
  if (now === 0) return <span className="text-muted-foreground">--</span>;
  return left > 0 ? (
    <span className="text-lg font-semibold tabular-nums">{formatCountdown(left)}</span>
  ) : (
    <span className="text-sm font-medium text-muted-foreground">{t("settling")}</span>
  );
}

function PositionCard({ p, market }: { p: OptionPosition; market: Market | undefined }) {
  const t = useTranslations("Options");
  const rise = p.direction === "rise";
  const price = (v: string) => (market ? formatPrice(v, market.priceDecimals) : v);
  const usd = (v: bigint) => t("usd", { amount: formatCents(v) });
  const result =
    p.status === "void" ? t("result.refunded") : p.result ? t(`result.${p.result}`) : null;

  return (
    <li className="rounded-xl border bg-card p-3 text-sm">
      <div className="flex items-center justify-between">
        <p className="font-medium">
          {market?.displaySymbol ?? p.marketId}{" "}
          <span className={rise ? "text-up" : "text-down"}>{t(p.direction)}</span>
        </p>
        {p.status === "open" ? (
          <Countdown expiresAt={p.expiresAt} />
        ) : (
          <span
            className={cn(
              "text-sm font-semibold",
              p.result === "win" ? "text-up" : p.result === "loss" ? "text-down" : "text-muted-foreground",
            )}
          >
            {result}
          </span>
        )}
      </div>
      <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs tabular-nums">
        <dt className="text-muted-foreground">{t("field.premium")}</dt>
        <dd className="text-right">{usd(p.premium)}</dd>
        <dt className="text-muted-foreground">{t("field.period")}</dt>
        <dd className="text-right">{t("seconds", { seconds: p.durationS })}</dd>
        <dt className="text-muted-foreground">{t("field.entry")}</dt>
        <dd className="text-right">{price(p.entryPrice)}</dd>
        <dt className="text-muted-foreground">{t("field.fee")}</dt>
        <dd className="text-right">{usd(p.fee)}</dd>
        {p.status !== "open" ? (
          <>
            <dt className="text-muted-foreground">{t("field.settlePrice")}</dt>
            <dd className="text-right">{p.settlePrice ? price(p.settlePrice) : "--"}</dd>
            <dt className="text-muted-foreground">{t("field.payout")}</dt>
            <dd className="text-right">{p.payout === null ? "--" : usd(p.payout)}</dd>
          </>
        ) : null}
        <dt className="text-muted-foreground">{t("field.opened")}</dt>
        <dd className="text-right">
          <time dateTime={p.createdAt}>{timeFormat.format(new Date(p.createdAt))}</time>
        </dd>
      </dl>
    </li>
  );
}

// Positions (open, with countdowns) and Fill (settled and void, newest first).
export function PositionsPanel({
  open,
  fills,
  error,
  markets,
  currentId,
}: {
  open: OptionPosition[] | null;
  fills: OptionPosition[] | null;
  error: boolean;
  markets: Market[];
  currentId: string;
}) {
  const t = useTranslations("Options");
  const [tab, setTab] = useState<"positions" | "fill">("positions");
  const [currentOnly, setCurrentOnly] = useState(false);
  const byId = new Map(markets.map((m) => [m.id, m]));
  const keep = (list: OptionPosition[] | null) =>
    list && currentOnly ? list.filter((p) => p.marketId === currentId) : list;
  const shownOpen = keep(open);
  const list = tab === "positions" ? shownOpen : keep(fills);

  return (
    <section className="mt-6">
      <div role="tablist" className="mb-3 flex gap-5 border-b text-sm">
        {(["positions", "fill"] as const).map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={cn(
              "-mb-px border-b-2 py-2",
              tab === key ? "border-primary font-semibold text-foreground" : "border-transparent text-muted-foreground",
            )}
          >
            {key === "positions" ? t("tabs.positions", { count: shownOpen?.length ?? 0 }) : t("tabs.fill")}
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
        <p className="text-sm text-muted-foreground">{t("loading")}</p>
      ) : list.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          {tab === "positions" ? t("noOpen") : t("noFills")}
        </p>
      ) : (
        <ul className="space-y-2">
          {list.map((p) => (
            <PositionCard key={p.id} p={p} market={byId.get(p.marketId)} />
          ))}
        </ul>
      )}
    </section>
  );
}
