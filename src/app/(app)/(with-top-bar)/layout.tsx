import { TopBar } from "@/components/app/top-bar";

export default function WithTopBarLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <TopBar />
      {/* pb-tabbar clears the tab bar, the raised Trade button and the home indicator (mobile only). */}
      <main className="mx-auto w-full max-w-[880px] flex-1 px-4 pt-4 pb-tabbar md:pb-8">
        {children}
      </main>
    </>
  );
}
