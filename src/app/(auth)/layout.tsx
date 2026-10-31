import Link from "next/link";
import { AuthBackground } from "@/components/auth/auth-background";
import { BrandMark } from "@/components/brand/brand-mark";
import { Wordmark } from "@/components/brand/wordmark";

// Static: an accidental cookies()/headers() call fails the build.
export const dynamic = "error";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex flex-1 flex-col items-center px-4 pt-[calc(var(--safe-t)+max(2rem,9dvh))] pb-[calc(2rem+var(--safe-b))]">
      <AuthBackground />
      <div className="w-full max-w-sm space-y-6">
        <Link href="/" aria-label="AureonX" className="flex flex-col items-center gap-3">
          <BrandMark variant="full" idPrefix="auth-logo" size={56} className="size-14" />
          <Wordmark className="h-5 w-auto" />
        </Link>
        <div className="rounded-xl border border-primary/25 bg-card/90 p-5 text-card-foreground [&_button[type=submit]]:h-12 [&_input[data-slot=input]]:h-12 [&_input[data-slot=input]]:text-base">
          {children}
        </div>
      </div>
    </main>
  );
}
