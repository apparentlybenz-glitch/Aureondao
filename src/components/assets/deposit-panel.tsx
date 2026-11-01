"use client";

import { useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { useTranslations } from "next-intl";
import { CoinNetworkFields } from "@/components/assets/coin-network-fields";
import { CopyButton } from "@/components/account/copy-button";
import { COINS, DEPOSIT_ADDRESSES, type NetworkKey } from "@/lib/coins";

// Coin and network pickers with the address of the chosen network, its copy
// button and a QR drawn from the same string (so they cannot disagree).
export function DepositPanel() {
  const t = useTranslations("Deposit");
  const [network, setNetwork] = useState<NetworkKey>(COINS[0].networks[0]);
  const address = DEPOSIT_ADDRESSES[network];

  return (
    <>
      <CoinNetworkFields onChange={setNetwork} />

      <div className="space-y-1.5">
        <p className="text-sm text-muted-foreground">{t("addressLabel")}</p>
        <div className="flex items-center gap-2">
          <p className="flex min-h-12 min-w-0 flex-1 items-center break-all rounded-xl border bg-muted/40 px-3 py-2 font-mono text-sm">
            {address}
          </p>
          <CopyButton value={address} label={t("copyAddress")} />
        </div>
      </div>

      <div className="flex justify-center">
        <div className="rounded-2xl bg-white p-3">
          <QRCodeSVG value={address} size={176} role="img" aria-label={t("qrLabel")} />
        </div>
      </div>
    </>
  );
}
