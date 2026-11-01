import { useTranslations } from "next-intl";
import { PageHeader } from "@/components/app/page-header";
import { DepositPanel } from "@/components/assets/deposit-panel";

// Shows the deposit address of the chosen network. Nothing here accepts a request:
// funds are virtual and an admin credits the account.
export default function DepositPage() {
  const t = useTranslations("Deposit");
  return (
    <div className="mx-auto w-full max-w-[480px] space-y-5">
      <PageHeader title={t("title")} back="/assets" />
      <p className="text-sm text-muted-foreground">{t("subtitle")}</p>

      <section className="space-y-5 rounded-2xl border bg-card p-4">
        <DepositPanel />
      </section>
    </div>
  );
}
