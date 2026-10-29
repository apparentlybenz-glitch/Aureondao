import { useTranslations } from "next-intl";
import { LegalDocument } from "@/components/legal/legal-document";
import { licensesAndDisclosures } from "@/lib/legal/licenses-and-disclosures";

export default function Page() {
  const t = useTranslations("LegalPages.titles");
  return <LegalDocument title={t("licenses")} {...licensesAndDisclosures} />;
}
