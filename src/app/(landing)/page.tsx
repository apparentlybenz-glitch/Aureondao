import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeftRight, ChartCandlestick, Timer } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { useTranslations } from "next-intl";
import { Faq } from "@/components/landing/faq";
import { HeroVisual } from "@/components/landing/hero-visual";
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
  { key: "spot", Icon: ChartCandlestick },
  { key: "options", Icon: Timer },
  { key: "assets", Icon: ArrowLeftRight },
] as const;

export default function LandingPage() {
  const t = useTranslations("Landing");
  return (
    <main className="mx-auto w-full max-w-6xl flex-1 space-y-16 px-4 py-10 md:space-y-24 md:py-16">
      <section className="grid items-center gap-10 md:grid-cols-2 md:gap-12">
        <div className="space-y-5">
          <h1 className="text-4xl leading-tight font-semibold tracking-tight text-balance md:text-5xl xl:text-6xl">
            {t("hero.title")}
          </h1>
          <p className="max-w-xl text-base text-muted-foreground md:text-lg">{t("hero.subtitle")}</p>
          <div className="flex flex-wrap gap-3 pt-1">
            <Link href="/sign-up" className={cn(buttonVariants(), "h-11 px-5 text-base")}>
              {t("hero.createAccount")}
            </Link>
            <Link href="/sign-in" className={cn(buttonVariants({ variant: "outline" }), "h-11 px-5 text-base")}>
              {t("hero.logIn")}
            </Link>
          </div>
        </div>
        <HeroVisual />
      </section>

      <section aria-label={t("features.label")} className="grid gap-4 md:grid-cols-3">
        {FEATURES.map(({ key, Icon }) => (
          <article key={key} className="space-y-3 rounded-xl border bg-card p-5">
            <Icon aria-hidden="true" className="size-6 text-primary" />
            <h2 className="text-lg font-semibold">{t(`features.${key}.title`)}</h2>
            <p className="text-sm text-muted-foreground">{t(`features.${key}.body`)}</p>
          </article>
        ))}
      </section>

      <Faq />
    </main>
  );
}
