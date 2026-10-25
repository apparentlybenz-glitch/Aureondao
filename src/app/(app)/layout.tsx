import { SessionGuard } from "@/components/app/session-guard";
import { TabBar } from "@/components/app/tab-bar";
import { TopBar } from "@/components/app/top-bar";

// Static shell: user data loads in client components. An accidental
// cookies()/headers() call fails the build.
export const dynamic = "error";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SessionGuard />
      <TopBar />
      {/* Bottom padding = tab bar (56 px) + raised Trade button room + safe-area inset. */}
      <main className="mx-auto w-full max-w-[880px] flex-1 px-4 pt-4 pb-[calc(56px+2rem+env(safe-area-inset-bottom))]">
        {children}
      </main>
      <TabBar />
    </>
  );
}
