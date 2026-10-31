"use client";

import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { ArrowDownToLine, ArrowUpToLine, Rows3 } from "lucide-react";
import { useTranslations } from "next-intl";
import { BOOK_POLL_MS, BOOK_TIMEOUT_MS, normalizeVisionDepth, visionDepthUrl } from "@/lib/market/book";
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

// Rows per side.
const BOOK_ROWS = 8;
// Grouping choices as multiples of the tick (10^-priceDecimals).
const GROUPS = [1, 10, 100] as const;

type Common = {
  base: string;
  quote: string;
  priceDecimals: number;
  qtyDecimals: number;
  // The desktop book card: a stacked view (asks, mid, bids with Both, Bids and Asks buttons) that
  // fills the height of its parent. Off everywhere else, so the compact grid stays as it was.
  fill?: boolean;
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
  const View = props.fill ? FillBookView : BookView;
  return (
    <View
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
  const View = props.fill ? FillBookView : BookView;
  return <View {...props} book={book} mid={mid} empty={t("loading")} />;
}

const CELL = "relative flex justify-between py-px text-[11px] leading-4 tabular-nums";

function BookView({
  book,
  mid,
  empty,
  note,
  base,
  quote,
  priceDecimals,
  qtyDecimals,
}: Common & { book: Book | null; mid: string | null; empty: string; note?: string }) {
  const t = useTranslations("Spot");
  const [group, setGroup] = useState<number>(GROUPS[0]);

  const asks = useMemo(
    () => (book ? withTotals(groupLevels(book.asks, "ask", priceDecimals, group).slice(0, BOOK_ROWS)) : []),
    [book, priceDecimals, group],
  );
  const bids = useMemo(
    () => (book ? withTotals(groupLevels(book.bids, "bid", priceDecimals, group).slice(0, BOOK_ROWS)) : []),
    [book, priceDecimals, group],
  );
  const QTY = 18;
  const max = [...asks, ...bids].reduce((m, l) => {
    const v = toUnits(l.total, QTY);
    return v > m ? v : m;
  }, BigInt(0));
  const width = (total: string) => (max > BigInt(0) ? Number((toUnits(total, QTY) * BigInt(1000)) / max) / 10 : 0);

  const price = t("columns.price", { quote });
  const amount = t("columns.amount", { base });
  // Depth bars start at the centre edge and grow outward.
  const cell = (l: { price: string; qty: string; total: string } | undefined, side: "bid" | "ask", i: number) => {
    const key = `${side}${i}`;
    if (!l) return <div key={key} aria-hidden="true" className={CELL}>&nbsp;</div>;
    const p = <span className={side === "bid" ? "text-up" : "text-down"}>{formatPrice(l.price, priceDecimals)}</span>;
    const q = <span>{formatPrice(l.qty, qtyDecimals)}</span>;
    return (
      <div key={key} className={CELL}>
        <span
          aria-hidden="true"
          className={cn("absolute inset-y-0", side === "bid" ? "right-0 bg-up/35" : "left-0 bg-down/35")}
          style={{ width: `${width(l.total)}%` }}
        />
        <span className="relative flex w-full justify-between">
          {side === "bid" ? q : p}
          {side === "bid" ? p : q}
        </span>
      </div>
    );
  };

  const rows = Math.max(asks.length, bids.length);

  return (
    <div>
      <div className="mb-2 flex justify-end">
        <select
          aria-label={t("group.label")}
          value={group}
          onChange={(e) => setGroup(Number(e.target.value))}
          className="h-6 rounded-md bg-muted px-2 text-[11px] tabular-nums text-foreground"
        >
          {GROUPS.map((g) => (
            <option key={g} value={g}>
              {formatPrice(fromUnits(BigInt(g), priceDecimals), priceDecimals)}
            </option>
          ))}
        </select>
      </div>
      {book ? (
        <>
          <p className="mb-1 flex items-baseline justify-center gap-2 border-y py-1 tabular-nums">
            <span className="text-sm font-bold">{mid ? formatMid(mid, priceDecimals) : "--"}</span>
            <span className="text-[10px] text-muted-foreground">{t("mid")}</span>
          </p>
          <div className="grid grid-cols-2 gap-x-2">
            <div className="flex justify-between pb-1 text-[10px] text-muted-foreground">
              <span>{amount}</span>
              <span>{price}</span>
            </div>
            <div className="flex justify-between pb-1 text-[10px] text-muted-foreground">
              <span>{price}</span>
              <span>{amount}</span>
            </div>
            {Array.from({ length: rows }, (_, i) => i).flatMap((i) => [cell(bids[i], "bid", i), cell(asks[i], "ask", i)])}
          </div>
        </>
      ) : (
        <p className="py-8 text-center text-sm text-muted-foreground">{empty}</p>
      )}
      {note ? <p className="pt-2 text-[11px] text-muted-foreground">{note}</p> : null}
    </div>
  );
}

type BookViewKey = "both" | "bids" | "asks";
const VIEWS = [
  { key: "both", Icon: Rows3, tone: "" },
  { key: "bids", Icon: ArrowDownToLine, tone: "text-up" },
  { key: "asks", Icon: ArrowUpToLine, tone: "text-down" },
] as const satisfies readonly { key: BookViewKey; Icon: typeof Rows3; tone: string }[];

// One fixed row height (px) so the number of whole rows that fit is exact. Rows are laid out
// with this value as their inline height.
const ROW_HEIGHT = 18;
const FILL_ROW = "relative grid shrink-0 grid-cols-3 items-center text-xs tabular-nums";

// Whole rows that fit in an element: floor(height / ROW_HEIGHT), kept current by a ResizeObserver.
// Takes the element in state (a callback ref) so it follows the element as it mounts and unmounts.
function useRowCount(el: HTMLElement | null): number {
  const [rows, setRows] = useState(0);
  useLayoutEffect(() => {
    if (!el) return;
    const measure = () => setRows(Math.floor(el.clientHeight / ROW_HEIGHT));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [el]);
  return rows;
}

// The stacked book for the desktop card: toolbar, then asks (best nearest the mid, aligned to the
// bottom of their area), the bold mid, then bids from the top. Asks and bids take equal shares of
// the height and each shows only the whole rows that fit (measured, capped at the levels fetched),
// so no row is ever cut. Same data and grouping as BookView.
function FillBookView({
  book,
  mid,
  empty,
  note,
  base,
  quote,
  priceDecimals,
  qtyDecimals,
}: Common & { book: Book | null; mid: string | null; empty: string; note?: string }) {
  const t = useTranslations("Spot");
  const [view, setView] = useState<BookViewKey>("both");
  const [group, setGroup] = useState<number>(GROUPS[0]);
  // The list under the mid: bids, or asks in the Asks view. In Both view the asks area has the
  // same height (equal flex shares), so its count is the same.
  const [area, setArea] = useState<HTMLElement | null>(null);
  const rows = useRowCount(area);

  const asks = useMemo(
    () => (book ? withTotals(groupLevels(book.asks, "ask", priceDecimals, group)).slice(0, rows) : []),
    [book, priceDecimals, group, rows],
  );
  const bids = useMemo(
    () => (book ? withTotals(groupLevels(book.bids, "bid", priceDecimals, group)).slice(0, rows) : []),
    [book, priceDecimals, group, rows],
  );
  const QTY = 18;
  const shown = [...(view !== "bids" ? asks : []), ...(view !== "asks" ? bids : [])];
  const max = shown.reduce((m, l) => {
    const v = toUnits(l.total, QTY);
    return v > m ? v : m;
  }, BigInt(0));
  const width = (total: string) => (max > BigInt(0) ? Number((toUnits(total, QTY) * BigInt(1000)) / max) / 10 : 0);

  const row = (l: { price: string; qty: string; total: string }, side: "bid" | "ask") => (
    <li key={`${side}${l.price}`} className={FILL_ROW} style={{ height: ROW_HEIGHT }}>
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
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mb-2 flex shrink-0 items-center justify-between gap-2">
        <div role="group" aria-label={t("bookView.label")} className="flex gap-1">
          {VIEWS.map(({ key, Icon, tone }) => (
            <button
              key={key}
              type="button"
              aria-pressed={view === key}
              aria-label={t(`bookView.${key}`)}
              title={t(`bookView.${key}`)}
              onClick={() => setView(key)}
              className={cn(
                "flex size-7 items-center justify-center rounded-md",
                view === key ? "bg-muted" : "opacity-60",
                tone,
              )}
            >
              <Icon className="size-4" />
            </button>
          ))}
        </div>
        <select
          aria-label={t("group.label")}
          value={group}
          onChange={(e) => setGroup(Number(e.target.value))}
          className="h-6 rounded-md bg-muted px-2 text-[11px] tabular-nums text-foreground"
        >
          {GROUPS.map((g) => (
            <option key={g} value={g}>
              {formatPrice(fromUnits(BigInt(g), priceDecimals), priceDecimals)}
            </option>
          ))}
        </select>
      </div>
      <div className="grid shrink-0 grid-cols-3 pb-1 text-[10px] text-muted-foreground">
        <span>{t("columns.price", { quote })}</span>
        <span className="text-right">{t("columns.amount", { base })}</span>
        <span className="text-right">{t("columns.total", { base })}</span>
      </div>
      {book ? (
        <>
          {view === "both" ? (
            <ul className="flex min-h-0 flex-1 basis-0 flex-col justify-end overflow-hidden">
              {[...asks].reverse().map((l) => row(l, "ask"))}
            </ul>
          ) : null}
          <p className="my-1 flex shrink-0 items-baseline justify-between border-y py-1.5 tabular-nums">
            <span className="text-base font-bold">{mid ? formatPrice(mid, priceDecimals) : "--"}</span>
            <span className="text-xs text-muted-foreground">{t("mid")}</span>
          </p>
          {view === "asks" ? (
            <ul ref={setArea} className="flex min-h-0 flex-1 basis-0 flex-col overflow-hidden">{asks.map((l) => row(l, "ask"))}</ul>
          ) : (
            <ul ref={setArea} className="flex min-h-0 flex-1 basis-0 flex-col overflow-hidden">{bids.map((l) => row(l, "bid"))}</ul>
          )}
        </>
      ) : (
        <p className="flex-1 py-8 text-center text-sm text-muted-foreground">{empty}</p>
      )}
      {note ? <p className="shrink-0 pt-2 text-[11px] text-muted-foreground">{note}</p> : null}
    </div>
  );
}
