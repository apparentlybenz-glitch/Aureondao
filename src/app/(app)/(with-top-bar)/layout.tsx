import { TopBar } from "@/components/app/top-bar";

export default function WithTopBarLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <TopBar />
      {/* Bottom padding = tab bar (56 px) + raised Trade button room + safe-area inset. */}
      <main className="mx-auto w-full max-w-[880px] flex-1 px-4 pt-4 pb-[calc(56px+2rem+env(safe-area-inset-bottom))]">
        {children}
      </main>
    </>
  );
}
