import { cn } from "@/lib/utils";

// The account pages' card: a title, then rows split by dividers.
export function InfoCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border bg-card px-4 py-2 md:px-6 md:py-3">
      <h2 className="py-2 text-base font-semibold">{title}</h2>
      <div className="divide-y">{children}</div>
    </section>
  );
}

// One row: label over value below md, side by side from md, the action on the right.
export function InfoRow({ label, children, action }: { label: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex min-h-14 items-center justify-between gap-3 py-3">
      <dl className="min-w-0 flex-1 md:flex md:items-center">
        <dt className="text-xs text-muted-foreground md:w-48 md:shrink-0 md:text-sm">{label}</dt>
        <dd className="mt-0.5 min-w-0 text-sm break-all md:mt-0">{children}</dd>
      </dl>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

// A status pill in the KycBadge style: green when on, grey otherwise.
export function StatusPill({ on = false, children }: { on?: boolean; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        "inline-block rounded-full px-2 py-0.5 text-[11px] font-semibold",
        on ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground",
      )}
    >
      {children}
    </span>
  );
}
