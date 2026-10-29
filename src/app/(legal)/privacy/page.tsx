import { useTranslations } from "next-intl";
import { LegalDocument } from "@/components/legal/legal-document";
import { privacy } from "@/lib/legal/privacy";

export default function Page() {
  const t = useTranslations("LegalPages.titles");
  return <LegalDocument title={t("privacy")} {...privacy} />;
}
