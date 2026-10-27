import { LandingFooter } from "@/components/landing/landing-footer";
import { LandingNav } from "@/components/landing/landing-nav";
import { PriceStrip } from "@/components/landing/price-strip";

// Public and static: nothing here reads the session, so the page is the same
// for every visitor. Signed-in visitors are redirected to /home by the proxy.
// No tab bar and no top bar.
export const dynamic = "error";

export default function LandingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-full flex-1 flex-col overflow-x-clip">
      <LandingNav />
      <PriceStrip />
      {children}
      <LandingFooter />
    </div>
  );
}
