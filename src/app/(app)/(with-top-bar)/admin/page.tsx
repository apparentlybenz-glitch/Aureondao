"use client";

import { useTranslations } from "next-intl";
import { AdminHeading } from "@/components/admin/admin-heading";
import { useSelectedUser, UserSearch } from "@/components/admin/selected-user";
import { UserDetail } from "@/components/admin/user-detail";

export default function AdminUserSearchPage() {
  const t = useTranslations("Admin");
  const { user, select } = useSelectedUser();
  return (
    <>
      <AdminHeading title={t("sections.search")} description={t("search.description")} />
      {user ? <UserDetail key={user.id} user={user} onBack={() => select(null)} /> : <UserSearch onPick={select} />}
    </>
  );
}
