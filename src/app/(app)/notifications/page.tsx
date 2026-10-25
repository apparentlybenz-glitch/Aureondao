import { useTranslations } from "next-intl";
import { ComingSoon } from "@/components/app/coming-soon";

export default function Page() {
  const t = useTranslations("Shell");
  return <ComingSoon title={t("notifications")} />;
}
