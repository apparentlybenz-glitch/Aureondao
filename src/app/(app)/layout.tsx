import { DesktopNav } from "@/components/app/desktop-nav";
import { NotificationListener } from "@/components/app/notification-listener";
import { SessionGuard } from "@/components/app/session-guard";
import { TabBar } from "@/components/app/tab-bar";
import { Toaster } from "@/components/app/toaster";

// Static shell: user data loads in client components. An accidental
// cookies()/headers() call fails the build.
// Desktop (md and up): DesktopNav is the top bar on every page and the tab bar
// is hidden. Mobile: the tab bar, plus the mobile top bar from the
// (with-top-bar) group layout, so full-screen trading screens can sit directly
// in (app) and skip it.
export const dynamic = "error";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SessionGuard />
      <NotificationListener />
      <DesktopNav />
      {children}
      <TabBar />
      <Toaster />
    </>
  );
}
