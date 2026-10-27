import Link from "next/link";
import { useTranslations } from "next-intl";
import { BrandMark } from "@/components/brand/brand-mark";
import { Wordmark } from "@/components/brand/wordmark";

const MARKET_LINKS = [
  { href: "/spot", key: "spot" },
  { href: "/options", key: "options" },
  { href: "/assets", key: "assets" },
] as const;

export function LandingFooter() {
  const t = useTranslations("Landing.footer");
  return (
    <footer className="mt-auto border-t">
      <div className="mx-auto max-w-6xl space-y-8 px-4 pt-10 pb-[calc(1.5rem+var(--safe-b))]">
        <div className="grid gap-8 md:grid-cols-2">
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <BrandMark variant="small" idPrefix="foot" className="size-8" />
              <Wordmark className="h-4 w-auto" />
            </div>
            <p className="text-sm text-muted-foreground">{t("tagline")}</p>
          </div>
          <nav aria-label={t("markets")} className="space-y-3 md:justify-self-end">
            <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{t("markets")}</h2>
            <ul className="space-y-2 text-sm">
              {MARKET_LINKS.map(({ href, key }) => (
                <li key={key}>
                  <Link href={href} className="hover:underline">
                    {t(key)}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </div>
        <div className="space-y-2 border-t pt-6 text-xs text-muted-foreground">
          <p>{t("disclosure")}</p>
          <p>{t("copyright")}</p>
        </div>
      </div>
    </footer>
  );
}
