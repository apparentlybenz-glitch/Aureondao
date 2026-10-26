import Link from "next/link";
import { useTranslations } from "next-intl";
import { SignedInRedirect } from "@/components/signed-in-redirect";

// Public root (static). The full public homepage is slice 9.
export default function PublicRoot() {
  const t = useTranslations("Public");
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      <SignedInRedirect to="/home" />
      <h1 className="text-3xl font-semibold tracking-tight">{t("title")}</h1>
      <p className="text-sm text-muted-foreground">{t("tagline")}</p>
      <Link href="/sign-in" className="text-sm underline">
        {t("signIn")}
      </Link>
    </main>
  );
}
