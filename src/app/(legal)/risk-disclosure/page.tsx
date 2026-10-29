import { useTranslations } from "next-intl";
import { LegalDocument } from "@/components/legal/legal-document";
import { riskDisclosure } from "@/lib/legal/risk-disclosure";

export default function Page() {
  const t = useTranslations("LegalPages.titles");
  return <LegalDocument title={t("risk")} {...riskDisclosure} />;
}
