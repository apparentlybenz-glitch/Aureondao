import { AccountTabs } from "@/components/app/account-tabs";
import { RouteTransition } from "@/components/app/route-transition";

export default function AccountLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <AccountTabs />
      <RouteTransition keyBy="path" variant="fade">
        {children}
      </RouteTransition>
    </>
  );
}
