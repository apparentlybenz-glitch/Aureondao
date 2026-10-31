import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeftRight, ArrowRight, ChartCandlestick, CircleCheck, Timer } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { useTranslations } from "next-intl";
import { Faq } from "@/components/landing/faq";
import { CtaBanner } from "@/components/landing/cta-banner";
import { HeroPreview } from "@/components/landing/hero-preview";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Landing");
  return {
    title: t("metaTitle"),
    description: t("metaDescription"),
    // The root opengraph-image file is dropped once a page sets openGraph, so
    // the same image is named here.
    openGraph: {
      title: t("metaTitle"),
      description: t("metaDescription"),
      type: "website",
      images: [{ url: "/opengraph-image.png", width: 1200, height: 630, alt: t("ogAlt") }],
    },
  };
}

const FEATURES = [
  { key: "spot", Icon: ChartCandlestick, href: "/spot" },
  { key: "options", Icon: Timer, href: "/options" },
  { key: "assets", Icon: ArrowLeftRight, href: "/assets" },
] as const;

const POINTS = ["one", "two", "three"] as const;

export default function LandingPage() {
  const t = useTranslations("Landing");
  return (
    <main className="mx-auto w-full max-w-6xl flex-1 space-y-16 px-4 py-10 md:space-y-24 md:py-16">
      <section className="grid items-center gap-10 lg:grid-cols-12 lg:gap-8">
        <div className="min-w-0 space-y-6 text-center lg:col-span-7 lg:text-left">
          <h1 className="text-4xl leading-tight font-semibold tracking-tight text-balance md:text-5xl xl:text-6xl">
            {t("hero.title")}
          </h1>
          <p className="mx-auto max-w-xl text-base text-muted-foreground md:text-lg lg:mx-0">{t("hero.subtitle")}</p>
          <div className="flex flex-col items-center gap-3 pt-1 sm:flex-row sm:justify-center lg:justify-start">
            <Link href="/sign-up" className={cn(buttonVariants(), "h-11 w-full px-5 text-base sm:w-auto")}>
              {t("hero.createAccount")}
            </Link>
            <Link href="/sign-in" className={cn(buttonVariants({ variant: "outline" }), "h-11 w-full px-5 text-base sm:w-auto")}>
              {t("hero.logIn")}
            </Link>
          </div>
        </div>
        <div className="mx-auto w-full min-w-0 max-w-md lg:col-span-5 lg:max-w-none">
          <HeroPreview />
        </div>
      </section>

      <section id="products" aria-labelledby="products-title" className="scroll-mt-6 space-y-10">
        <div className="mx-auto max-w-3xl space-y-3 text-center">
          <p className="text-xs font-medium tracking-wide text-primary uppercase">{t("features.eyebrow")}</p>
          <h2 id="products-title" className="text-2xl font-semibold tracking-tight md:text-3xl">
            {t("features.title")}
          </h2>
          <p className="text-sm text-muted-foreground md:text-base">{t("features.subtitle")}</p>
        </div>
        <div className="grid gap-4 md:grid-cols-3 md:gap-6">
          {FEATURES.map(({ key, Icon, href }) => (
            <article key={key} className="flex flex-col justify-between gap-8 rounded-2xl border bg-card p-6">
              <div className="space-y-4">
                <span className="flex size-12 items-center justify-center rounded-xl bg-muted">
                  <Icon aria-hidden="true" className="size-6 text-primary" />
                </span>
                <h3 className="text-lg font-semibold">{t(`features.${key}.title`)}</h3>
                <p className="text-sm text-muted-foreground">{t(`features.${key}.body`)}</p>
                <ul className="space-y-2 pt-1 text-sm">
                  {POINTS.map((point) => (
                    <li key={point} className="flex items-center gap-2">
                      <CircleCheck aria-hidden="true" className="size-4 shrink-0 text-primary" />
                      {t(`features.${key}.points.${point}`)}
                    </li>
                  ))}
                </ul>
              </div>
              <Link href={href} className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline">
                {t(`features.${key}.cta`)}
                <ArrowRight aria-hidden="true" className="size-4" />
              </Link>
            </article>
          ))}
        </div>
      </section>

      <Faq />

      <CtaBanner />
    </main>
  );
}
