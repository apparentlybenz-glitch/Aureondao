import { cn } from "@/lib/utils";

// The coin icon: an initials badge (the first two letters of the symbol).
export function CoinBadge({ symbol, className }: { symbol: string; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-semibold",
        className,
      )}
    >
      {symbol.slice(0, 2)}
    </span>
  );
}
