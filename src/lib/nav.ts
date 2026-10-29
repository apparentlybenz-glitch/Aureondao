import { ArrowLeftRight, ChartCandlestick, House, Timer, Wallet } from "lucide-react";

// The one list of main destinations. The mobile bottom tab bar and the desktop
// top bar both render it; Trade opens Spot (O24 ★). Labels are Shell.<key>.
export const NAV_ITEMS = [
  { href: "/home", key: "home", Icon: House },
  { href: "/market", key: "market", Icon: ChartCandlestick },
  { href: "/spot", key: "trade", Icon: ArrowLeftRight },
  { href: "/options", key: "options", Icon: Timer },
  { href: "/assets", key: "assets", Icon: Wallet },
] as const;
