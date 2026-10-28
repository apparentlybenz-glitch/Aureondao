import { useTranslations } from "next-intl";

export default function Page() {
  const t = useTranslations("Legal");
  return (
    <div className="space-y-2">
      <h1 className="text-lg font-semibold">{t("title")}</h1>
      <p className="text-sm text-muted-foreground">{t("virtualFunds")}</p>
    </div>
  );
}
