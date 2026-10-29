import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { useTranslations } from "next-intl";
import type { LegalSection } from "@/lib/legal/types";

export function LegalDocument({
  title,
  subtitle,
  version,
  effectiveDate,
  sections,
}: {
  title: string;
  subtitle?: string;
  version: string;
  effectiveDate: string;
  sections: LegalSection[];
}) {
  const t = useTranslations("LegalPages");
  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-4 pt-[calc(1.5rem+var(--safe-t))] pb-[calc(3rem+var(--safe-b))]">
      <Link href="/" className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
        <ChevronLeft className="size-4" aria-hidden />
        {t("back")}
      </Link>
      <h1 className="mt-6 text-2xl font-semibold tracking-tight">{title}</h1>
      {subtitle && <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>}
      <p className="mt-2 text-xs text-muted-foreground">
        {t("lastUpdated")}: {effectiveDate} · {t("version")} {version}
      </p>
      <div className="mt-8 space-y-8">
        {sections.map((section) => (
          <section key={section.heading} className="space-y-3">
            <h2 className="text-base font-medium">{section.heading}</h2>
            {section.paragraphs.map((paragraph) => (
              <p key={paragraph} className="text-sm leading-relaxed text-muted-foreground">
                {paragraph}
              </p>
            ))}
          </section>
        ))}
      </div>
    </main>
  );
}
