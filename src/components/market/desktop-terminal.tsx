import type { ReactNode } from "react";
import { useTranslations } from "next-intl";

// Desktop (xl and up) layout shared by Spot, Options and Forex: a strip across the top, then
// one fixed-height row (chart, book, trading) and a full-width bottom panel. Layout only: every
// slot is built by the terminal, and the terminals mount this from xl and their own markup below
// it, never both.
export function DesktopTerminal({
  strip,
  chart,
  book,
  trading,
  bottom,
}: {
  strip: ReactNode;
  chart: ReactNode;
  book: ReactNode;
  trading: ReactNode;
  bottom: ReactNode;
}) {
  const t = useTranslations("Terminal");
  const card = "flex min-h-0 flex-col overflow-hidden rounded-xl border bg-card";
  return (
    <div className="mx-auto w-full max-w-[1680px] px-6 pt-[calc(0.75rem+var(--safe-t))] pb-8">
      <div className="mb-4 flex min-h-[4.5rem] items-center rounded-xl border bg-card px-4 py-3 *:w-full">{strip}</div>
      <div className="grid h-[620px] grid-cols-[minmax(0,1fr)_300px_340px] gap-4">
        <div className="min-w-0 overflow-hidden rounded-xl border bg-card">{chart}</div>
        <section aria-label={t("book")} className={card}>
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-3">{book}</div>
        </section>
        <section aria-label={t("trading")} className={card}>
          <h2 className="border-b px-3 py-2.5 text-sm font-semibold">{t("trading")}</h2>
          {/* The ticket forms draw their own card border: drop it so borders do not double. */}
          <div className="min-h-0 flex-1 overflow-y-auto p-3 [&>form]:rounded-none [&>form]:border-0 [&>form]:bg-transparent [&>form]:p-0">
            {trading}
          </div>
        </section>
      </div>
      <div className="mt-4 rounded-xl border bg-card p-4 [&>section]:mt-0">{bottom}</div>
    </div>
  );
}
