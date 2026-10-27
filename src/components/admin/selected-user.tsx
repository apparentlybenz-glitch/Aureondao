"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { StateBadge } from "@/components/admin/state-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { type AdminUser, fetchUser, searchUsers } from "@/lib/admin";
import { cn } from "@/lib/utils";

// The user the admin is working on. It lives in the admin layout, so it carries
// across sections; a page reload clears it.
type Selected = { user: AdminUser | null; select: (user: AdminUser | null) => void; reload: () => Promise<void> };

const SelectedUserContext = createContext<Selected | null>(null);

export function SelectedUserProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AdminUser | null>(null);
  const id = user?.id ?? null;

  const reload = useCallback(async () => {
    if (!id) return;
    const fresh = await fetchUser(id);
    if (fresh) setUser((prev) => (prev?.id === id ? fresh : prev));
  }, [id]);

  return <SelectedUserContext value={{ user, select: setUser, reload }}>{children}</SelectedUserContext>;
}

export function useSelectedUser(): Selected {
  const value = useContext(SelectedUserContext);
  if (!value) throw new Error("useSelectedUser needs SelectedUserProvider");
  return value;
}

// Search box and result list. Empty search lists the newest users.
export function UserSearch({ onPick, selectedId }: { onPick: (user: AdminUser) => void; selectedId?: string }) {
  const t = useTranslations("Admin");
  const c = useTranslations("Common");
  const [query, setQuery] = useState("");
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback((q: string) => {
    void searchUsers(q).then((rows) => {
      setFailed(rows === null);
      setUsers(rows ?? []);
    });
  }, []);

  useEffect(() => {
    let active = true;
    searchUsers("").then((rows) => {
      if (!active) return;
      setFailed(rows === null);
      setUsers(rows ?? []);
    });
    return () => {
      active = false;
    };
  }, []);

  return (
    <div className="space-y-4">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          load(query);
        }}
        className="flex gap-2"
      >
        <Input
          aria-label={t("search.label")}
          placeholder={t("search.placeholder")}
          className="h-11 min-w-0 flex-1 text-base"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <Button type="submit" className="h-11">
          {t("search.submit")}
        </Button>
        <Button
          type="button"
          variant="secondary"
          className="h-11"
          onClick={() => {
            setQuery("");
            load("");
          }}
        >
          {t("search.all")}
        </Button>
      </form>

      {users === null ? <p className="text-sm">{c("loading")}</p> : null}
      {failed ? <p className="text-sm text-destructive">{t("loadError")}</p> : null}
      {users?.length === 0 && !failed ? <p className="text-sm text-muted-foreground">{t("search.noUsers")}</p> : null}
      <ul className="space-y-2">
        {users?.map((u) => (
          <li key={u.id}>
            <button
              type="button"
              onClick={() => onPick(u)}
              className={cn(
                "flex w-full items-center justify-between gap-3 rounded-xl border bg-card p-3 text-left",
                selectedId === u.id ? "border-primary" : "",
              )}
            >
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">{u.email ?? u.nickname}</span>
                <span className="block font-mono text-xs text-muted-foreground">{t("uid", { uid: u.uid })}</span>
              </span>
              <StateBadge suspended={u.suspended_at !== null} />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// The chosen user at the top of Top-Up and Restrictions, with a way to change.
export function SelectedUserCard({ user, onChange, changeLabel }: { user: AdminUser; onChange: () => void; changeLabel: string }) {
  const t = useTranslations("Admin");
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border bg-card p-3">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{user.email ?? user.nickname}</p>
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="font-mono">{t("uid", { uid: user.uid })}</span>
          <StateBadge suspended={user.suspended_at !== null} />
        </p>
      </div>
      <Button type="button" variant="secondary" className="h-9 shrink-0" onClick={onChange}>
        {changeLabel}
      </Button>
    </div>
  );
}
