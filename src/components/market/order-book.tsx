"use client";

import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { BOOK_LEVELS, BOOK_POLL_MS, BOOK_TIMEOUT_MS, normalizeVisionDepth, visionDepthUrl } from "@/lib/market/book";
import type { Book } from "@/lib/market/book";
import { formatMid, formatPrice } from "@/lib/market/decimal";
import { getJson } from "@/lib/market/http";
import { fromUnits, generateLadder, groupLevels, toUnits, withTotals } from "@/lib/market/ladder";
import type { Market } from "@/lib/market/types";
import { usePoll } from "@/lib/market/use-poll";
import { midPrice } from "@/lib/spot-math";
import { useHydrated } from "@/lib/use-hydrated";
import { cn } from "@/lib/utils";

const browserFetch = (url: string, init: { signal: AbortSignal }) => fetch(url, init);
const every5s = () => BOOK_POLL_MS;

type View = "both" | "bids" | "asks";
const BOTH_LEVELS = 10;
// Grouping choices as multiples of the tick (10^-priceDecimals).
const GROUPS = [1, 10, 100] as const;

type Common = {
  base: string;
  quote: string;
  priceDecimals: number;
  qtyDecimals: number;
  // Rows per side in the Asks and Bids views (the Both view shows 10).
  levels?: number;
};

export type OrderBookProps =
  | (Common & { mode: "real"; market: Pick<Market, "id" | "visionSymbol"> })
  | (Common & { mode: "generated"; id: string; mid: string | null });

// One book for Spot, Options and Forex. "real" polls Vision depth for the symbol while the
// page is visible; "generated" is a deterministic ladder around `mid` for an instrument
// with no public depth (src/lib/market/ladder.ts). Display only: orders never read it.
export function OrderBook(props: OrderBookProps) {
  return props.mode === "real" ? <RealBook {...props} /> : <GeneratedBook {...props} />;
}

function RealBook(props: Common & { mode: "real"; market: Pick<Market, "id" | "visionSymbol"> }) {
  const t = useTranslations("Spot");
  const { market } = props;
  const poll = usePoll(
    `depth|${market.id}`,
    async () => normalizeVisionDepth(await getJson(browserFetch, visionDepthUrl(market), BOOK_TIMEOUT_MS)),
    every5s,
  );
  const best = poll.data && poll.data.bids[0] && poll.data.asks[0] ? midPrice(poll.data.bids[0].price, poll.data.asks[0].price) : null;
  return (
    <BookView
      {...props}
      book={poll.data}
      mid={best}
      empty={poll.failing ? t("bookUnavailable") : t("loading")}
      note={t("bookNote")}
    />
  );
}

const GENERATED_LEVELS = 20;

function GeneratedBook(props: Common & { mode: "generated"; id: string; mid: string | null }) {
  const t = useTranslations("Spot");
  const hydrated = useHydrated();
  // The minute changes once a minute; the check runs every 5 s, and an unchanged value does not re-render.
  const [minute, setMinute] = useState(() => Math.floor(Date.now() / 60_000));
  useEffect(() => {
    const timer = setInterval(() => setMinute(Math.floor(Date.now() / 60_000)), 5_000);
    return () => clearInterval(timer);
  }, []);
  const { id, mid, priceDecimals, qtyDecimals } = props;
  // Not built in the prerendered HTML: the minute differs between the build and the visit.
  const book = useMemo(
    () =>
      hydrated && mid
        ? generateLadder({ id, mid, priceDecimals, qtyDecimals, levels: GENERATED_LEVELS, minute })
        : null,
    [hydrated, id, mid, priceDecimals, qtyDecimals, minute],
  );
  return <BookView {...props} book={book} mid={mid} empty={t("loading")} />;
}

function BookView({
  book,
  mid,
  empty,
  note,
  base,
  quote,
  priceDecimals,
  qtyDecimals,
  levels = BOOK_LEVELS,
}: Common & { book: Book | null; mid: string | null; empty: string; note?: string }) {
  const t = useTranslations("Spot");
  const [view, setView] = useState<View>("both");
  const [group, setGroup] = useState<number>(GROUPS[0]);

  const depth = view === "both" ? BOTH_LEVELS : levels;
  const asks = useMemo(
    () => (book ? withTotals(groupLevels(book.asks, "ask", priceDecimals, group).slice(0, depth)) : []),
    [book, priceDecimals, group, depth],
  );
  const bids = useMemo(
    () => (book ? withTotals(groupLevels(book.bids, "bid", priceDecimals, group).slice(0, depth)) : []),
    [book, priceDecimals, group, depth],
  );
  const QTY = 18;
  const shown = [...(view !== "bids" ? asks : []), ...(view !== "asks" ? bids : [])];
  const max = shown.reduce((m, l) => {
    const v = toUnits(l.total, QTY);
    return v > m ? v : m;
  }, BigInt(0));
  const width = (total: string) => (max > BigInt(0) ? Number((toUnits(total, QTY) * BigInt(1000)) / max) / 10 : 0);

  const row = (l: { price: string; qty: string; total: string }, side: "bid" | "ask") => (
    <li key={`${side}${l.price}`} className="relative grid grid-cols-3 py-0.5 text-[13px] tabular-nums">
      <span
        aria-hidden="true"
        className={cn("absolute inset-y-0 right-0", side === "bid" ? "bg-up/35" : "bg-down/35")}
        style={{ width: `${width(l.total)}%` }}
      />
      <span className={cn("relative", side === "bid" ? "text-up" : "text-down")}>{formatPrice(l.price, priceDecimals)}</span>
      <span className="relative text-right">{formatPrice(l.qty, qtyDecimals)}</span>
      <span className="relative text-right">{formatPrice(l.total, qtyDecimals)}</span>
    </li>
  );

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <div role="group" aria-label={t("bookView.label")} className="flex gap-2">
          {(["both", "bids", "asks"] as const).map((key) => (
            <button
              key={key}
              type="button"
              aria-pressed={view === key}
              onClick={() => setView(key)}
              className={cn(
                "h-7 rounded-md px-2.5 text-xs",
                view === key ? "bg-muted font-semibold text-foreground" : "text-muted-foreground",
              )}
            >
              {t(`bookView.${key}`)}
            </button>
          ))}
        </div>
        <select
          aria-label={t("group.label")}
          value={group}
          onChange={(e) => setGroup(Number(e.target.value))}
          className="h-7 rounded-md bg-muted px-2 text-xs tabular-nums text-foreground"
        >
          {GROUPS.map((g) => (
            <option key={g} value={g}>
              {formatPrice(fromUnits(BigInt(g), priceDecimals), priceDecimals)}
            </option>
          ))}
        </select>
      </div>
      <div className="grid grid-cols-3 pb-1 text-xs text-muted-foreground">
        <span>{t("columns.price", { quote })}</span>
        <span className="text-right">{t("columns.amount", { base })}</span>
        <span className="text-right">{t("columns.total", { base })}</span>
      </div>
      {book ? (
        <>
          {view !== "bids" ? <ul>{[...asks].reverse().map((l) => row(l, "ask"))}</ul> : null}
          {view === "both" ? (
            <p className="my-1 flex items-baseline justify-between border-y py-1.5 tabular-nums">
              <span className="text-base font-bold">{mid ? formatMid(mid, priceDecimals) : "--"}</span>
              <span className="text-xs text-muted-foreground">{t("mid")}</span>
            </p>
          ) : null}
          {view !== "asks" ? <ul>{bids.map((l) => row(l, "bid"))}</ul> : null}
        </>
      ) : (
        <p className="py-8 text-center text-sm text-muted-foreground">{empty}</p>
      )}
      {note ? <p className="pt-2 text-[11px] text-muted-foreground">{note}</p> : null}
    </div>
  );
}
