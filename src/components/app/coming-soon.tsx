import { useTranslations } from "next-intl";

// Plain placeholder for screens that later slices build.
export function ComingSoon({ title }: { title: string }) {
  const t = useTranslations("Common");
  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center gap-2 text-center">
      <h1 className="text-lg font-semibold">{title}</h1>
      <p className="text-sm font-medium">{t("comingSoon")}</p>
      <p className="text-sm text-muted-foreground">{t("comingSoonBody")}</p>
    </div>
  );
}
