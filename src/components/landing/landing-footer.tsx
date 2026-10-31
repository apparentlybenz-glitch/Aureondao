import Link from "next/link";
import { useTranslations } from "next-intl";
import { BrandMark } from "@/components/brand/brand-mark";
import { Wordmark } from "@/components/brand/wordmark";

const COLUMNS = [
  {
    heading: "markets",
    links: [
      { href: "/spot", key: "spot" },
      { href: "/options", key: "options" },
      { href: "/assets", key: "assets" },
    ],
  },
  {
    heading: "legal",
    links: [
      { href: "/terms", key: "terms" },
      { href: "/privacy", key: "privacy" },
      { href: "/risk-disclosure", key: "risk" },
      { href: "/licenses-and-disclosures", key: "licenses" },
    ],
  },
  {
    heading: "company",
    links: [
      { href: "/support", key: "support" },
      { href: "/sign-in", key: "signIn" },
      { href: "/sign-up", key: "signUp" },
    ],
  },
] as const;

export function LandingFooter() {
  const t = useTranslations("Landing.footer");
  return (
    <footer className="mt-auto border-t">
      <div className="mx-auto max-w-6xl space-y-8 px-4 pt-10 pb-[calc(1.5rem+var(--safe-b))]">
        <div className="grid grid-cols-2 gap-x-6 gap-y-8 md:grid-cols-[1.4fr_1fr_1fr_1fr]">
          <div className="col-span-2 space-y-3 md:col-span-1">
            <div className="flex items-center gap-2">
              <BrandMark variant="small" idPrefix="foot" className="size-8" />
              <Wordmark className="h-4 w-auto" />
            </div>
            <p className="max-w-xs text-sm text-muted-foreground">{t("tagline")}</p>
          </div>
          {COLUMNS.map(({ heading, links }) => (
            <nav key={heading} aria-label={t(heading)} className="space-y-3">
              <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{t(heading)}</h2>
              <ul className="space-y-2.5 text-sm">
                {links.map(({ href, key }) => (
                  <li key={key}>
                    <Link href={href} className="hover:underline">
                      {t(key)}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>
        <div className="space-y-2 border-t pt-6 text-xs text-muted-foreground">
          <p>{t("copyright")}</p>
        </div>
      </div>
    </footer>
  );
}
