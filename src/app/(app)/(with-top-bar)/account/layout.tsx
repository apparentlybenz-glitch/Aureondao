import { AccountTabs } from "@/components/app/account-tabs";

export default function AccountLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <AccountTabs />
      {children}
    </>
  );
}
