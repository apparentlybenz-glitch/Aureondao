import Image from "next/image";
import { useId } from "react";
import { currencyIcon, instrumentParts } from "@/lib/forex-icons";
import type { CurrencyIcon } from "@/lib/forex-icons";
import { cn } from "@/lib/utils";

const SIZES = { sm: 20, md: 28, lg: 36 } as const;

// The two metal badge colors: plain two-stop gradients, original artwork.
const GOLD = { from: "#f3d98b", to: "#b8892b", text: "#5a3f08" } as const;
const SILVER = { from: "#eceff2", to: "#9aa3ad", text: "#363d45" } as const;

// Surface the icon sits on: the ring that separates the quote flag from the base takes its color.
const RING = { background: "ring-background", card: "ring-card", popover: "ring-popover" } as const;

function Metal({ metal, px }: { metal: "gold" | "silver"; px: number }) {
  const id = useId();
  const c = metal === "gold" ? GOLD : SILVER;
  return (
    <svg width={px} height={px} viewBox="0 0 32 32" aria-hidden="true" className="shrink-0">
      <defs>
        <linearGradient id={id} x1="4" y1="2" x2="28" y2="30" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor={c.from} />
          <stop offset="1" stopColor={c.to} />
        </linearGradient>
      </defs>
      <circle cx="16" cy="16" r="16" fill={`url(#${id})`} />
      <text x="16" y="21" textAnchor="middle" fontSize="14" fontWeight="700" fontFamily="sans-serif" fill={c.text}>
        {metal === "gold" ? "Au" : "Ag"}
      </text>
    </svg>
  );
}

function One({ code, icon, px }: { code: string; icon: CurrencyIcon; px: number }) {
  if (icon.kind === "flag") {
    // Our own file, served from /icons/flags; unoptimized images render as a plain img.
    return <Image src={`/icons/flags/${icon.file}.svg`} alt="" width={px} height={px} className="shrink-0 rounded-full" />;
  }
  if (icon.kind === "metal") return <Metal metal={icon.metal} px={px} />;
  return (
    <span
      aria-hidden="true"
      style={{ width: px, height: px, fontSize: Math.max(7, Math.round(px * 0.3)) }}
      className="flex shrink-0 items-center justify-center rounded-full bg-muted font-semibold text-muted-foreground"
    >
      {code.slice(0, 3)}
    </span>
  );
}

// The one Forex instrument icon: the base flag (or metal badge) with the quote flag smaller at
// the bottom right on a 2 px ring in the surface color.
export function ForexIcon({
  id,
  size = "md",
  surface = "background",
  className,
}: {
  id: string;
  size?: keyof typeof SIZES;
  surface?: keyof typeof RING;
  className?: string;
}) {
  const { base, quote } = instrumentParts(id);
  const px = SIZES[size];
  const small = Math.round(px * 0.52);
  return (
    <span
      role="img"
      aria-label={`${base} and ${quote}`}
      style={{ width: px, height: px }}
      className={cn("relative inline-block shrink-0", className)}
    >
      <One code={base} icon={currencyIcon(base)} px={px} />
      <span
        style={{ width: small, height: small }}
        className={cn("absolute -right-0.5 -bottom-0.5 overflow-hidden rounded-full ring-2", RING[surface])}
      >
        <One code={quote} icon={currencyIcon(quote)} px={small} />
      </span>
    </span>
  );
}
