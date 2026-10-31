"use client";

import { useId, useState } from "react";
import { ChevronDown } from "lucide-react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import { buildFaqItems } from "./faq-items";

export function Faq() {
  const t = useTranslations("Faq");
  const base = useId();
  const items = buildFaqItems(t);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set([items[0].id]));

  function toggle(id: string) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  return (
    <section aria-labelledby={`${base}-title`} className="mx-auto w-full max-w-3xl space-y-6">
      <div className="space-y-2 text-center">
        <h2 id={`${base}-title`} className="text-2xl font-semibold tracking-tight md:text-3xl">
          {t("title")}
        </h2>
        <p className="text-sm text-muted-foreground md:text-base">{t("subtitle")}</p>
      </div>
      <div className="space-y-3">
        {items.map((item) => {
          const isOpen = open.has(item.id);
          const buttonId = `${base}-${item.id}-button`;
          const panelId = `${base}-${item.id}-panel`;
          return (
            <div key={item.id} className="rounded-xl border bg-card">
              <h3>
                <button
                  type="button"
                  id={buttonId}
                  aria-expanded={isOpen}
                  aria-controls={panelId}
                  onClick={() => toggle(item.id)}
                  className="flex w-full items-center justify-between gap-4 rounded-xl p-4 text-left text-base font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring md:p-5"
                >
                  <span>{item.question}</span>
                  <ChevronDown
                    aria-hidden="true"
                    className={cn(
                      "size-5 shrink-0 text-muted-foreground transition-transform duration-200 motion-reduce:transition-none",
                      isOpen && "rotate-180",
                    )}
                  />
                </button>
              </h3>
              <div
                id={panelId}
                role="region"
                aria-labelledby={buttonId}
                inert={!isOpen}
                className={cn(
                  "grid transition-[grid-template-rows] duration-200 motion-reduce:transition-none",
                  isOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
                )}
              >
                <div className="overflow-hidden">
                  <div className="px-4 pb-4 text-sm text-muted-foreground md:px-5 md:pb-5">{item.answer}</div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
