import { SessionGuard } from "@/components/app/session-guard";
import { TabBar } from "@/components/app/tab-bar";

// Static shell: user data loads in client components. An accidental
// cookies()/headers() call fails the build.
// The top bar lives in the (with-top-bar) group layout, so full-screen
// trading screens can sit directly in (app) and skip it.
export const dynamic = "error";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SessionGuard />
      {children}
      <TabBar />
    </>
  );
}
