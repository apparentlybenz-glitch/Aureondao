import Link from "next/link";
import { useTranslations } from "next-intl";
import { SessionGuard } from "@/components/app/session-guard";
import { SignOutButton } from "@/components/app/sign-out-button";
import { Badge } from "@/components/ui/badge";

// Static shell: user data loads in client components. An accidental
// cookies()/headers() call fails the build.
export const dynamic = "error";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const t = useTranslations("Common");
  return (
    <>
      <SessionGuard />
      <header className="flex h-14 items-center gap-2 border-b px-4">
        <Link href="/" className="font-semibold tracking-tight">
          AureonX
        </Link>
        <Badge className="bg-amber-500 text-black hover:bg-amber-500">{t("virtualFundsBadge")}</Badge>
        <nav className="ml-auto flex items-center gap-1 text-sm">
          <Link href="/account" className="hidden px-2 md:inline">
            {t("account")}
          </Link>
          <Link href="/account/security" className="hidden px-2 md:inline">
            {t("security")}
          </Link>
          <SignOutButton />
        </nav>
      </header>
      <main className="mx-auto w-full max-w-[880px] flex-1 px-4 pt-6 pb-[calc(1.5rem+env(safe-area-inset-bottom))]">
        {children}
      </main>
    </>
  );
}
