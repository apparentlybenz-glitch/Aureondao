import { useTranslations } from "next-intl";
import { LegalDocument } from "@/components/legal/legal-document";
import { terms } from "@/lib/legal/terms";

export default function Page() {
  const t = useTranslations("LegalPages.titles");
  return <LegalDocument title={t("terms")} {...terms} />;
}
