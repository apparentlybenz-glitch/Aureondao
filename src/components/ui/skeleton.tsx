import { cn } from "@/lib/utils";

// A placeholder block in the dark surface color with a shimmer sweeping across it every 1.4 s
// (.skeleton in globals.css; a still block under reduced motion). Size and shape come from
// className, so each one matches the content it stands in for.
export function Skeleton({ className }: { className?: string }) {
  return <span aria-hidden="true" className={cn("skeleton block rounded-md", className)} />;
}

// A loading region: announces the label to screen readers and shows the skeletons inside it.
export function Loading({ label, className, children }: { label: string; className?: string; children: React.ReactNode }) {
  return (
    <div role="status" className={className}>
      <span className="sr-only">{label}</span>
      {children}
    </div>
  );
}

// A list still loading: rows shaped like list rows (a full-width bar, h-12 by default).
export function LoadingRows({
  label,
  rows = 3,
  rowClassName,
  className,
}: {
  label: string;
  rows?: number;
  rowClassName?: string;
  className?: string;
}) {
  return (
    <Loading label={label} className={cn("space-y-2", className)}>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className={cn("h-12 w-full rounded-lg", rowClassName)} />
      ))}
    </Loading>
  );
}

// A value still loading inside a line of text (a balance): an inline block sized by className.
export function InlineLoading({ label, className }: { label: string; className?: string }) {
  return (
    <span role="status" className="inline-block align-middle">
      <span className="sr-only">{label}</span>
      <Skeleton className={cn("inline-block", className)} />
    </span>
  );
}
