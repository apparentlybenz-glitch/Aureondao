import type { ReactNode } from "react";
import Link from "next/link";
import { Mail, TriangleAlert } from "lucide-react";
import type { useTranslations } from "next-intl";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { DEPOSIT_MINIMUMS } from "@/lib/coins";

export type FaqItem = { id: string; question: string; answer: ReactNode };

// Keys under `Faq.items` in messages/en.json, in display order.
export const FAQ_KEYS = [
  "deposit",
  "depositTime",
  "withdrawTime",
  "start",
  "fees",
  "security",
  "support",
] as const;

type FaqTranslate = ReturnType<typeof useTranslations<"Faq">>;

// Item 1 builds its table from DEPOSIT_MINIMUMS in src/lib/coins.ts.
export function buildFaqItems(t: FaqTranslate): FaqItem[] {
  return FAQ_KEYS.map((key) => ({
    id: key,
    question: t(`items.${key}.question`),
    answer: key === "deposit" ? depositAnswer(t) : key === "withdrawTime" ? withdrawAnswer(t) : key === "support" ? supportAnswer(t) : <p>{t(`items.${key}.answer`)}</p>,
  }));
}

const WITHDRAW_ROWS = ["trc20", "erc20", "btc", "sol"] as const;

function withdrawAnswer(t: FaqTranslate): ReactNode {
  return (
    <div className="space-y-3">
      <p>{t("items.withdrawTime.answer")}</p>
      <ul className="list-disc space-y-1.5 pl-5 marker:text-primary">
        {WITHDRAW_ROWS.map((row) => (
          <li key={row}>{t(`items.withdrawTime.${row}`)}</li>
        ))}
      </ul>
      <p>{t("items.withdrawTime.closing")}</p>
    </div>
  );
}

// The card sends the visitor to /support. A signed-out visitor is sent to
// sign-in first by the proxy.
function supportAnswer(t: FaqTranslate): ReactNode {
  return (
    <div className="space-y-4">
      <p>{t("items.support.answer")}</p>
      <div className="space-y-3 rounded-xl border bg-background p-4">
        <Mail aria-hidden="true" className="size-5 text-primary" />
        <p className="font-semibold text-primary">{t("items.support.helpTitle")}</p>
        <p>{t("items.support.helpBody")}</p>
        <Link href="/support" className={cn(buttonVariants({ variant: "outline" }), "h-10 w-full")}>
          {t("items.support.helpButton")}
        </Link>
      </div>
    </div>
  );
}

function depositAnswer(t: FaqTranslate): ReactNode {
  return (
    <div className="space-y-3">
      <p>{t("items.deposit.answer")}</p>
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full min-w-[20rem] text-left text-sm">
          <thead className="bg-muted text-xs tracking-wide text-muted-foreground">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">{t("items.deposit.colAsset")}</th>
              <th scope="col" className="px-3 py-2 font-medium">{t("items.deposit.colNetwork")}</th>
              <th scope="col" className="px-3 py-2 font-medium">{t("items.deposit.colMinimum")}</th>
            </tr>
          </thead>
          <tbody>
            {DEPOSIT_MINIMUMS.map((row) => (
              <tr key={row.id} className="border-t">
                <td className="px-3 py-2.5 font-medium text-foreground">{t(`items.deposit.rows.${row.id}.asset`)}</td>
                <td className="px-3 py-2.5">{t(`items.deposit.rows.${row.id}.network`)}</td>
                <td className="px-3 py-2.5 whitespace-nowrap text-foreground">{`${row.min} ${row.symbol}`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="flex gap-2 rounded-lg bg-muted p-3 text-foreground">
        <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        <span>{t("items.deposit.notice")}</span>
      </p>
    </div>
  );
}
