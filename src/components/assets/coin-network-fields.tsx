"use client";

import { useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { Select } from "radix-ui";
import { useTranslations } from "next-intl";
import { CoinIcon } from "@/components/market/coin-icon";
import { COINS, type CoinSymbol } from "@/lib/coins";
import { cn } from "@/lib/utils";

// Coin dropdown and network chips, shared by Deposit and Withdraw. Choosing a
// coin selects its first network. The choice stays on this screen: nothing is
// sent or stored.
export function CoinNetworkFields() {
  const t = useTranslations("Deposit");
  const [symbol, setSymbol] = useState<CoinSymbol>(COINS[0].symbol);
  const coin = COINS.find((c) => c.symbol === symbol) ?? COINS[0];
  const [network, setNetwork] = useState<string>(coin.networks[0]);

  function pickCoin(next: string) {
    const picked = COINS.find((c) => c.symbol === next);
    if (!picked) return;
    setSymbol(picked.symbol);
    setNetwork(picked.networks[0]);
  }

  return (
    <div className="space-y-5">
      <div className="space-y-1.5">
        <p id="coin-label" className="text-sm text-muted-foreground">
          {t("selectCoin")}
        </p>
        <Select.Root value={symbol} onValueChange={pickCoin}>
          <Select.Trigger
            aria-labelledby="coin-label"
            className="flex h-14 w-full items-center gap-3 rounded-xl border bg-muted/40 px-3 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <Select.Value>
              <span className="flex items-center gap-3">
                <CoinIcon symbol={coin.symbol} size={32} />
                <span className="font-semibold">{coin.symbol}</span>
                <span className="text-sm text-muted-foreground">{t(`coins.${coin.symbol}`)}</span>
              </span>
            </Select.Value>
            <Select.Icon className="ml-auto">
              <ChevronDown className="size-4 text-muted-foreground" />
            </Select.Icon>
          </Select.Trigger>
          <Select.Portal>
            <Select.Content
              position="popper"
              sideOffset={6}
              className="z-50 w-(--radix-select-trigger-width) overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-lg origin-(--radix-select-content-transform-origin) ease-out-strong data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=open]:duration-180 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=closed]:duration-120 motion-reduce:data-[state=open]:zoom-in-100 motion-reduce:data-[state=closed]:zoom-out-100"
            >
              <Select.Viewport className="overscroll-contain p-1">
                {COINS.map((c) => (
                  <Select.Item
                    key={c.symbol}
                    value={c.symbol}
                    className="flex h-12 cursor-pointer items-center gap-3 rounded-lg px-2 outline-none data-highlighted:bg-muted"
                  >
                    <CoinIcon symbol={c.symbol} size={24} />
                    <span className="font-semibold">
                      <Select.ItemText>{c.symbol}</Select.ItemText>
                    </span>
                    <span className="text-sm text-muted-foreground">{t(`coins.${c.symbol}`)}</span>
                    <Select.ItemIndicator className="ml-auto">
                      <Check className="size-4 text-primary" />
                    </Select.ItemIndicator>
                  </Select.Item>
                ))}
              </Select.Viewport>
            </Select.Content>
          </Select.Portal>
        </Select.Root>
      </div>

      <div className="space-y-1.5">
        <p id="network-label" className="text-sm text-muted-foreground">
          {t("selectNetwork")}
        </p>
        <div role="radiogroup" aria-labelledby="network-label" className="flex flex-wrap gap-2">
          {coin.networks.map((n) => (
            <button
              key={n}
              type="button"
              role="radio"
              aria-checked={network === n}
              onClick={() => setNetwork(n)}
              className={cn(
                "flex h-10 items-center gap-2 rounded-lg border px-4 text-sm font-medium",
                network === n ? "border-primary bg-primary/10 text-primary" : "text-muted-foreground",
              )}
            >
              <CoinIcon symbol={n} kind="network" size={20} />
              {t(`networks.${n}`)}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
