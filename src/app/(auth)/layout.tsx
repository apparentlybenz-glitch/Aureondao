import Link from "next/link";
import { useTranslations } from "next-intl";

// Static: an accidental cookies()/headers() call fails the build.
export const dynamic = "error";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  const t = useTranslations("Common");
  return (
    <main className="flex flex-1 flex-col items-center px-4 pt-12 pb-[calc(2rem+env(safe-area-inset-bottom))] md:justify-center md:pt-0">
      <div className="w-full max-w-sm space-y-6">
        <Link href="/" className="block text-center text-2xl font-semibold tracking-tight">
          AureonX
        </Link>
        <div className="rounded-xl border bg-card p-5 text-card-foreground">{children}</div>
        <p className="text-center text-xs text-muted-foreground">{t("virtualFundsNote")}</p>
      </div>
    </main>
  );
}
