"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { SupportFab } from "@/components/app/support-fab";
import { DepthTabs } from "@/components/market/depth-tabs";
import { DesktopTerminal } from "@/components/market/desktop-terminal";
import { OrderBook } from "@/components/market/order-book";
import { TerminalSkeleton } from "@/components/market/terminal-skeleton";
import { TerminalStrip } from "@/components/market/terminal-strip";
import { TradingViewChart } from "@/components/market/tradingview-chart";
import { changePercent } from "@/lib/forex-math";
import { forexTvSymbol } from "@/lib/forex-pairs";
import { useFxFeed, useFxInstruments, useFxPositions, useFxPrice } from "@/lib/forex";
import type { FxInstrument } from "@/lib/forex";
import { formatChange, formatPrice } from "@/lib/market/decimal";
import { usePeriods } from "@/lib/options";
import { LG, XL, useMediaQuery } from "@/lib/use-media-query";
import { useWallets } from "@/lib/wallets";
import { cn } from "@/lib/utils";
import { ForexHeader, ForexInfo, ForexPairPicker } from "./forex-header";
import { ForexPositions } from "./forex-positions";
import { ForexTicket } from "./forex-ticket";

const QTY_DECIMALS = 0;

// /forex: header, chart, ticket, then Positions / History. Layout copied from OptionsTerminal.
// The book is a generated ladder around the newest stored price (no public depth exists for
// forex); from lg it is a right-hand column and the ticket sits under the chart, below lg the
// header icon opens it under the header.
export function ForexTerminal() {
  const m = useTranslations("Market");
  const instruments = useFxInstruments();
  if (!instruments || instruments.length === 0) return <TerminalSkeleton label={m("loading")} />;
  return <ForexScreen instruments={instruments} />;
}

function ForexScreen({ instruments }: { instruments: FxInstrument[] }) {
  const t = useTranslations("Forex");
  const [pickedId, setPickedId] = useState(instruments[0].id);
  const [bookShown, setBookShown] = useState(false);
  const instrument = instruments.find((i) => i.id === pickedId) ?? instruments[0];
  const { periods } = usePeriods("fx_periods");
  const status = useFxFeed();
  const { wallets, reload: reloadWallets } = useWallets();
  const positions = useFxPositions();
  const { loaded, last, dayAgo } = useFxPrice(instrument.id);
  const wide = useMediaQuery(LG);
  const desktop = useMediaQuery(XL);

  // Settle and void change a wallet in the same transaction as the position row, so every
  // positions update after the first load reloads the wallets too.
  const { active, history } = positions;
  const positionsLoaded = useRef(false);
  useEffect(() => {
    if (active === null || history === null) return;
    if (!positionsLoaded.current) {
      positionsLoaded.current = true;
      return;
    }
    void reloadWallets();
  }, [active, history, reloadWallets]);

  const dp = instrument.priceDecimals;
  const price = last ? formatPrice(last.price, dp) : "--";
  const pct = last && dayAgo ? changePercent(last.price, dayAgo.price) : null;
  const change = pct === null ? "--" : formatChange(pct);
  const tone = change.startsWith("+") ? "up" : change.startsWith("-") ? "down" : undefined;
  const forex = wallets?.find((w) => w.account === "forex") ?? null;
  const classStatus = status ? status[instrument.cls] : null;
  const tvSymbol = forexTvSymbol(instrument.id);

  const depthFor = (fill: boolean) => (
    <DepthTabs
      fill={fill}
      book={
        <OrderBook
          mode="generated"
          id={instrument.id}
          mid={last?.price ?? null}
          emptyLabel={loaded ? t("noPrice") : undefined}
          base={instrument.base}
          quote={instrument.quote}
          priceDecimals={dp}
          qtyDecimals={QTY_DECIMALS}
          fill={fill}
        />
      }
    />
  );
  const depth = depthFor(false);

  const ticket = (
    <ForexTicket
      key={instrument.id}
      instrument={instrument}
      price={last ? price : null}
      periods={periods}
      available={forex ? forex.available : null}
      status={classStatus}
      onOpened={() => {
        void positions.reload();
        void reloadWallets();
      }}
    />
  );
  const positionsPanel = (
    <ForexPositions
      active={positions.active}
      history={positions.history}
      error={positions.error}
      instruments={instruments}
      currentId={instrument.id}
    />
  );

  // From xl the shared desktop layout replaces everything below. No stat cells: only the last
  // price and the 24 hour change are stored.
  if (desktop) {
    return (
      <>
        <DesktopTerminal
          strip={
            <TerminalStrip
              picker={<ForexPairPicker instrument={instrument} instruments={instruments} onPick={setPickedId} />}
              price={price}
              priceTone={tone}
              below={
                <span className={cn(tone === "up" && "text-up", tone === "down" && "text-down", !tone && "text-muted-foreground")}>
                  {change}
                </span>
              }
              actions={<ForexInfo periods={periods} />}
            />
          }
          chart={<TradingViewChart key={tvSymbol} symbol={tvSymbol} className="h-full rounded-none border-0 lg:h-full" />}
          book={depthFor(true)}
          trading={ticket}
          bottom={positionsPanel}
        />
        <SupportFab />
      </>
    );
  }

  return (
    <div className="mx-auto w-full max-w-[1100px] px-4 pt-[calc(0.75rem+var(--safe-t))] pb-[calc(var(--tab-bar-h)+5rem+var(--safe-b))] md:pb-8">
      <ForexHeader
        instrument={instrument}
        instruments={instruments}
        periods={periods}
        bookShown={bookShown}
        price={price}
        change={change}
        tone={tone}
        onPick={setPickedId}
        onToggleBook={() => setBookShown((s) => !s)}
      />
      {!wide && bookShown ? <div className="mb-4">{depth}</div> : null}
      <div className="space-y-4 md:grid md:grid-cols-[minmax(0,1fr)_340px] md:gap-6 md:space-y-0 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 lg:col-start-1 lg:row-start-1">
          <TradingViewChart key={tvSymbol} symbol={tvSymbol} />
        </div>
        <div className="lg:col-start-1 lg:row-start-2">{ticket}</div>
        {wide ? <aside className="min-w-0 lg:col-start-2 lg:row-span-2 lg:row-start-1">{depth}</aside> : null}
      </div>
      {positionsPanel}
      <SupportFab />
    </div>
  );
}
