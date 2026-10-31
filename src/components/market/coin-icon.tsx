import Image from "next/image";
import { cn } from "@/lib/utils";

// The one coin and network icon. Files are vendored from web3icons (MIT, branded
// variant, license beside them) in public/icons/crypto and public/icons/network.
// To add a symbol: copy its branded SVG to public/icons/crypto/<lowercase>.svg and
// add the symbol here. A symbol not listed renders a neutral letter circle (a
// placeholder, not a logo), so no missing file is ever requested.
const COINS = new Set(
  (
    "BTC ETH ZEC SOL XRP NEAR BNB SUI PEPE UNI DOGE TRX QNT HYPE LINK TAO ADA AAVE AVAX DOT LTC ATOM ARB INJ " +
    "FIL ETC SHIB HBAR ICP FET BCH OP APT SEI TIA RENDER USDT USDC"
  ).split(" "),
);

// Deposit and Withdraw network keys (src/lib/coins.ts) to the chain's icon file.
const NETWORKS: Record<string, string> = { bitcoin: "bitcoin", trc20: "tron", erc20: "ethereum", solana: "solana" };

export function CoinIcon({
  symbol,
  kind = "coin",
  size = 24,
  className,
}: {
  symbol: string;
  kind?: "coin" | "network";
  size?: 16 | 20 | 24 | 28 | 32;
  className?: string;
}) {
  const file = kind === "network" ? NETWORKS[symbol] : COINS.has(symbol) ? symbol.toLowerCase() : undefined;
  if (!file) {
    return (
      <span
        aria-hidden="true"
        style={{ width: size, height: size, fontSize: Math.round(size * 0.4) }}
        className={cn(
          "flex shrink-0 items-center justify-center rounded-full bg-muted font-semibold text-muted-foreground",
          className,
        )}
      >
        {symbol.slice(0, 2).toUpperCase()}
      </span>
    );
  }
  return (
    <Image
      src={`/icons/${kind === "network" ? "network" : "crypto"}/${file}.svg`}
      alt=""
      width={size}
      height={size}
      className={cn("shrink-0", className)}
    />
  );
}
