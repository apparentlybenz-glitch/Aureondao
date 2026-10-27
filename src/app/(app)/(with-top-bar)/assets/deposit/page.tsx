import { Copy } from "lucide-react";
import { useTranslations } from "next-intl";
import { PageHeader } from "@/components/app/page-header";
import { CoinNetworkFields } from "@/components/assets/coin-network-fields";
import { BrandMark } from "@/components/brand/brand-mark";
import { Button } from "@/components/ui/button";

// Display only. No deposit address exists and nothing here accepts a request:
// funds are virtual and an admin credits the account.
export default function DepositPage() {
  const t = useTranslations("Deposit");
  return (
    <div className="mx-auto w-full max-w-[480px] space-y-5">
      <PageHeader title={t("title")} back="/assets" />
      <p className="text-sm text-muted-foreground">{t("subtitle")}</p>

      <section className="space-y-5 rounded-2xl border bg-card p-4">
        <CoinNetworkFields />

        <div className="space-y-1.5">
          <p className="text-sm text-muted-foreground">{t("addressLabel")}</p>
          <div className="flex gap-2">
            <p className="flex h-12 min-w-0 flex-1 items-center rounded-xl border bg-muted/40 px-3 font-mono text-sm">
              {t("addressEmpty")}
            </p>
            <Button type="button" variant="secondary" disabled className="h-12 gap-1.5 px-4">
              <Copy className="size-4" />
              {t("copy")}
            </Button>
          </div>
        </div>

        <div className="flex justify-center">
          <div
            aria-hidden="true"
            className="flex size-44 items-center justify-center rounded-2xl border bg-muted/40"
          >
            <BrandMark variant="small" idPrefix="deposit-frame" size={56} />
          </div>
        </div>

        <p className="text-sm text-muted-foreground">{t("note")}</p>
      </section>
    </div>
  );
}
