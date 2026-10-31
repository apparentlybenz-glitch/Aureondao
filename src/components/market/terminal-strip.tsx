import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import { formatChange, formatPrice, toSortNumber } from "@/lib/market/decimal";
import { isDelayed } from "@/lib/market/types";
import type { Market, Ticker } from "@/lib/market/types";
import { cn } from "@/lib/utils";

export type StripStat = { label: string; value: string };

// The strip card's content at xl: picker button, last price with its change beneath, labelled
// stat cells, and the terminal's own buttons at the right. Presentational only.
export function TerminalStrip({
  picker,
  price,
  priceTone,
  below,
  stats,
  statsLabel,
  actions,
}: {
  picker: ReactNode;
  price: string;
  priceTone?: "up" | "down";
  below?: ReactNode;
  stats?: StripStat[];
  statsLabel?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-8">
      <div className="flex shrink-0 items-center gap-6">
        <div className="space-y-0.5">
          {picker}
        </div>
        <div className="min-w-[8rem]">
          <p
            className={cn(
              "text-2xl leading-tight font-semibold tabular-nums",
              priceTone === "up" && "text-up",
              priceTone === "down" && "text-down",
            )}
          >
            {price}
          </p>
          <div className="text-xs tabular-nums">{below}</div>
        </div>
      </div>
      {stats && stats.length > 0 ? (
        <dl aria-label={statsLabel} className="flex min-w-0 flex-1 items-center gap-8 text-sm tabular-nums">
          {stats.map((s) => (
            <div key={s.label}>
              <dt className="text-xs text-muted-foreground">{s.label}</dt>
              <dd className="font-medium">{s.value}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <div className="flex-1" />
      )}
      {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
    </div>
  );
}

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 });

// Strip for the crypto terminals (Spot and Options): last price coloured by the 24 h
// direction, change beneath, Buy (ask), Sell (bid), 24 h high, low and volume.
export function CryptoStrip({
  market,
  ticker,
  now,
  picker,
  actions,
}: {
  market: Market;
  ticker: Ticker | undefined;
  now: number;
  picker: ReactNode;
  actions?: ReactNode;
}) {
  const t = useTranslations("Terminal");
  const spot = useTranslations("Spot");
  const m = useTranslations("Market");
  const dp = market.priceDecimals;
  const change = ticker ? formatChange(ticker.changePct) : null;
  const tone = change?.startsWith("+") ? "up" : change?.startsWith("-") ? "down" : undefined;
  const fmt = (v: string | undefined) => (v ? formatPrice(v, dp) : "--");
  return (
    <TerminalStrip
      picker={picker}
      price={ticker ? formatPrice(ticker.last, dp) : "--"}
      priceTone={tone}
      below={
        <span className="flex items-center gap-2">
          {change ? <span className={cn(tone === "up" && "text-up", tone === "down" && "text-down")}>{change}</span> : null}
          {ticker && isDelayed(ticker.ts, now) ? <span className="text-muted-foreground">{m("delayed")}</span> : null}
        </span>
      }
      statsLabel={spot("stats.label")}
      stats={[
        { label: t("buy"), value: fmt(ticker?.ask) },
        { label: t("sell"), value: fmt(ticker?.bid) },
        { label: spot("stats.high"), value: fmt(ticker?.high) },
        { label: spot("stats.low"), value: fmt(ticker?.low) },
        {
          label: spot("stats.volume", { quote: market.quote }),
          value: ticker ? compact.format(toSortNumber(ticker.quoteVolume)) : "--",
        },
      ]}
      actions={actions}
    />
  );
}
