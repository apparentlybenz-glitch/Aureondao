import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { useTranslations } from "next-intl";

// Title row for inner pages, with a back link to the parent screen.
export function PageHeader({ title, back }: { title: string; back?: string }) {
  const t = useTranslations("Common");
  return (
    <div className="mb-4 flex items-center gap-2">
      {back ? (
        <Link href={back} aria-label={t("back")} className="-ml-2 flex size-9 items-center justify-center rounded-full">
          <ChevronLeft className="size-5" />
        </Link>
      ) : null}
      <h1 className="text-lg font-semibold">{title}</h1>
    </div>
  );
}
