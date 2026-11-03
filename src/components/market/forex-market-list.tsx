"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { LoadingRows } from "@/components/ui/skeleton";
import { ForexIcon } from "@/components/forex/forex-icon";
import { useFxFeed, useFxInstruments, useFxTable } from "@/lib/forex";
import { etParts, fxChangePercent, fxDisplay } from "@/lib/forex-math";
import { formatChange, formatPrice } from "@/lib/market/decimal";
import { cn } from "@/lib/utils";

const GRID = "grid min-w-0 flex-1 grid-cols-[minmax(7.5rem,1.6fr)_minmax(0,1fr)_4.5rem] items-center gap-1";

// The Forex tab of the Market page: the enabled instruments in sort order with the newest
// stored price and the 24 h change. A row opens /forex?instrument=. Running the feed heartbeat
// here (and only while this tab is mounted) keeps the hourly prices coming.
export function ForexMarketList({ query }: { query: string }) {
  const t = useTranslations("Market");
  const f = useTranslations("Forex");
  const instruments = useFxInstruments();
  const status = useFxFeed();
  const rows = useFxTable(instruments?.map((i) => i.id) ?? []);

  const q = query.trim().toLowerCase();
  const shown = (instruments ?? []).filter((i) => !q || fxDisplay(i.id).toLowerCase().includes(q) || i.id.toLowerCase().includes(q));

  // The terminal's closed wording, for the first closed class (fx before metals).
  const closedClass = status ? (status.fx.closed ? status.fx : status.metal.closed ? status.metal : null) : null;
  const opens = closedClass?.opensAt ? etParts(closedClass.opensAt) : null;

  return (
    <div className="space-y-3">
      {closedClass ? (
        <p role="status" className="rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">
          {opens ? f("closed", { weekday: opens.weekday, time: opens.time }) : f("closedNoTime")}
        </p>
      ) : null}
      <div className="flex items-center text-xs text-muted-foreground">
        <div className={GRID}>
          <span>{t("columns.symbol")}</span>
          <span className="text-right">{t("columns.last")}</span>
          <span className="text-right">{t("columns.change")}</span>
        </div>
      </div>
      {instruments === null || (instruments.length > 0 && rows === null) ? (
        <LoadingRows label={t("loading")} rows={8} className="space-y-3 py-2.5" rowClassName="h-9" />
      ) : shown.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">{t("noResults")}</p>
      ) : (
        <ul>
          {shown.map((i) => {
            const row = rows?.[i.id];
            const pct = fxChangePercent(row?.last ?? null, row?.dayAgo ?? null);
            const change = pct === null ? null : formatChange(pct);
            const tone = change?.startsWith("+")
              ? "bg-up/15 text-up"
              : change?.startsWith("-")
                ? "bg-down/15 text-down"
                : "bg-muted text-muted-foreground";
            const closed = status ? status[i.cls].closed : false;
            return (
              <li key={i.id}>
                <Link href={`/forex?instrument=${encodeURIComponent(i.id)}`} className={cn(GRID, "press py-2.5")}>
                  <span className="flex min-w-0 items-center gap-1.5">
                    <ForexIcon id={i.id} />
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">{fxDisplay(i.id)}</span>
                      {closed ? <span className="block text-[11px] text-muted-foreground">{t("closed")}</span> : null}
                    </span>
                  </span>
                  <span className="truncate text-right text-[13px] tabular-nums">
                    {row?.last ? formatPrice(row.last.price, i.priceDecimals) : "--"}
                  </span>
                  <span className={cn("rounded-md px-1.5 py-1 text-right text-xs font-medium tabular-nums", tone)}>
                    {change ?? "--"}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
