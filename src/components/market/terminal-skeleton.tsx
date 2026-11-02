import { Loading, Skeleton } from "@/components/ui/skeleton";

// Spot and Options before the market list arrives: the header, the chart and the ticket,
// in the terminal's own padding.
export function TerminalSkeleton({ label }: { label: string }) {
  return (
    <Loading
      label={label}
      className="mx-auto w-full max-w-[1100px] space-y-3 px-4 pt-[calc(0.75rem+var(--safe-t))] pb-[calc(var(--tab-bar-h)+5rem+var(--safe-b))] md:pb-8"
    >
      <div className="flex items-center gap-2">
        <Skeleton className="size-7 rounded-full" />
        <Skeleton className="h-6 w-28" />
      </div>
      <Skeleton className="h-[420px] w-full rounded-xl lg:h-[520px]" />
      <div className="grid grid-cols-2 gap-2">
        <Skeleton className="h-9 rounded-lg" />
        <Skeleton className="h-9 rounded-lg" />
      </div>
      <Skeleton className="h-11 w-full rounded-lg" />
      <Skeleton className="h-11 w-full rounded-lg" />
    </Loading>
  );
}
