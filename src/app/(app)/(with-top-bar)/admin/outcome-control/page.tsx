"use client";

import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { useTranslations } from "next-intl";
import { AdminHeading } from "@/components/admin/admin-heading";
import { FormError } from "@/components/auth/field";
import { useRpcMessage } from "@/components/app/use-rpc-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { useAttemptKey } from "@/lib/attempt-key";
import {
  loadOutcomeConfig,
  loadOutcomeOverrides,
  OUTCOME_MODES,
  type OutcomeConfig,
  type OutcomeMode,
  type OutcomeOverride,
} from "@/lib/outcome-control";
import { serverAnswered } from "@/lib/rpc-error";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";

const selectClass =
  "h-11 w-full rounded-lg border border-input bg-input px-3 text-base outline-none focus-visible:ring-3 focus-visible:ring-ring/50";

const LABEL = {
  market: "market",
  force_win: "forceWin",
  force_loss: "forceLoss",
  controlled: "controlled",
} as const;
const NOTE = {
  market: "marketNote",
  force_win: "forceWinNote",
  force_loss: "forceLossNote",
  controlled: "controlledNote",
} as const;
const DOT = {
  market: "bg-muted-foreground",
  force_win: "bg-up",
  force_loss: "bg-down",
  controlled: "bg-primary",
} as const;

export default function OutcomeControlPage() {
  const t = useTranslations("Admin");
  const c = useTranslations("Common");
  const [config, setConfig] = useState<OutcomeConfig | null | undefined>(undefined);
  const [overrides, setOverrides] = useState<OutcomeOverride[] | null | undefined>(undefined);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let active = true;
    void loadOutcomeConfig().then((r) => {
      if (active) setConfig(r);
    });
    void loadOutcomeOverrides().then((r) => {
      if (active) setOverrides(r);
    });
    return () => {
      active = false;
    };
  }, [version]);

  const refresh = useCallback(() => setVersion((v) => v + 1), []);
  const reloadOverrides = useCallback(() => {
    void loadOutcomeOverrides().then(setOverrides);
  }, []);
  const failed = config === null || overrides === null;

  return (
    <>
      <AdminHeading title={t("sections.outcomeControl")} description={t("outcomeControl.description")} />
      {config === undefined || overrides === undefined ? <p className="text-sm">{c("loading")}</p> : null}
      {failed ? <p className="text-sm text-destructive">{t("loadError")}</p> : null}
      {config && overrides ? (
        <div className="space-y-5">
          <GlobalCard config={config} onSaved={setConfig} onRefresh={refresh} />
          <PerUserCard onChanged={reloadOverrides} />
          <OverrideList rows={overrides} onChanged={reloadOverrides} />
        </div>
      ) : null}
    </>
  );
}

function GlobalCard({ config, onSaved, onRefresh }: { config: OutcomeConfig; onSaved: (next: OutcomeConfig) => void; onRefresh: () => void }) {
  const t = useTranslations("Admin");
  const rpcMessage = useRpcMessage();
  const attempt = useAttemptKey();
  const [mode, setMode] = useState<OutcomeMode>(config.mode);
  const [rate, setRate] = useState(config.winRatePct);
  const signature = `${config.mode}:${config.winRatePct}`;
  const [seen, setSeen] = useState(signature);
  if (seen !== signature) {
    setSeen(signature);
    setMode(config.mode);
    setRate(config.winRatePct);
  }
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const dirty = mode !== config.mode || rate !== config.winRatePct;

  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending || !dirty) return;
    setPending(true);
    setError(null);
    setDone(false);
    const key = attempt.keyFor(`${mode}|${rate}`);
    const { error } = await createClient().rpc("admin_set_outcome_config", {
      p_mode: mode,
      p_win_rate_pct: rate,
      p_client_request_id: key,
    });
    setPending(false);
    if (error) {
      if (serverAnswered(error)) attempt.settle();
      setError(rpcMessage(error));
      return;
    }
    attempt.settle();
    setDone(true);
    onSaved({ mode, winRatePct: rate });
  }

  function pick(next: OutcomeMode) {
    setMode(next);
    setError(null);
    setDone(false);
  }

  return (
    <section className="space-y-4 rounded-xl border bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-medium">{t("outcomeControl.title")}</h2>
          <p className="text-sm text-muted-foreground">{t("outcomeControl.subtitle")}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="rounded-full bg-secondary px-2 py-0.5 text-[11px] font-semibold">{t(`outcomeControl.${LABEL[config.mode]}`)}</span>
          <button
            type="button"
            onClick={onRefresh}
            aria-label={t("outcomeControl.refresh")}
            className="flex size-9 items-center justify-center rounded-lg text-muted-foreground hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            <RefreshCw className="size-4" aria-hidden />
          </button>
        </div>
      </div>

      <form onSubmit={save} className="space-y-4">
        <div className="space-y-2">
          <p className="text-sm font-medium">{t("outcomeControl.globalMode")}</p>
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            {OUTCOME_MODES.map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={mode === m}
                onClick={() => pick(m)}
                className={cn(
                  "flex h-16 flex-col items-start justify-center gap-1.5 rounded-lg border px-3 text-left text-sm font-medium transition-colors",
                  mode === m ? "border-primary bg-primary/10" : "border-border bg-card hover:bg-muted",
                )}
              >
                <span className={cn("size-2 rounded-full", DOT[m])} />
                {t(`outcomeControl.${LABEL[m]}`)}
              </button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">{t(`outcomeControl.${NOTE[mode]}`)}</p>
        </div>

        {mode === "controlled" ? (
          <div className="space-y-2 rounded-lg border bg-background/40 p-3">
            <div className="flex items-center justify-between text-sm">
              <span className="font-medium">{t("outcomeControl.winRate")}</span>
              <span className="tabular-nums text-muted-foreground">
                {t("outcomeControl.winLossSplit", { win: rate, loss: 100 - rate })}
              </span>
            </div>
            <Slider min={0} max={100} step={1} value={[rate]} onValueChange={(v) => setRate(v[0] ?? 0)} />
          </div>
        ) : null}

        <div className="space-y-2">
          <p className="text-sm font-medium">{t("outcomeControl.appliesTo")}</p>
          <span className="inline-flex rounded-full border border-primary bg-primary/10 px-3 py-1 text-sm font-medium text-primary">
            {t("outcomeControl.optionsOnly")}
          </span>
          <p className="text-xs text-muted-foreground">{t("outcomeControl.optionsOnlyNote")}</p>
        </div>

        <FormError message={error} />
        {done ? (
          <p role="status" className="text-sm text-up">
            {t("outcomeControl.saved")}
          </p>
        ) : null}
        <Button type="submit" className="h-11" disabled={!dirty || pending}>
          {pending ? t("outcomeControl.saving") : t("outcomeControl.save")}
        </Button>
      </form>
    </section>
  );
}

function PerUserCard({ onChanged }: { onChanged: () => void }) {
  const t = useTranslations("Admin");
  const rpcMessage = useRpcMessage();
  const attempt = useAttemptKey();
  const [email, setEmail] = useState("");
  const [mode, setMode] = useState<OutcomeMode>("force_win");
  const [rate, setRate] = useState(50);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const valid = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim());

  async function apply(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending || !valid) return;
    setPending(true);
    setError(null);
    setDone(null);
    const key = attempt.keyFor(`${email.trim().toLowerCase()}|${mode}|${rate}`);
    const { error } = await createClient().rpc("admin_set_outcome_override", {
      p_email: email.trim(),
      p_mode: mode,
      p_win_rate_pct: rate,
      p_client_request_id: key,
    });
    setPending(false);
    if (error) {
      if (serverAnswered(error)) attempt.settle();
      setError(rpcMessage(error));
      return;
    }
    attempt.settle();
    setDone(t("outcomeControl.overrideSaved", { email: email.trim().toLowerCase() }));
    setEmail("");
    onChanged();
  }

  return (
    <section className="space-y-4 rounded-xl border bg-card p-4">
      <h2 className="font-medium">{t("outcomeControl.perUser")}</h2>
      <form onSubmit={apply} className="space-y-3">
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,12rem)_auto] md:items-end">
          <div className="space-y-1.5">
            <Label htmlFor="outcome-email">{t("outcomeControl.userEmail")}</Label>
            <Input
              id="outcome-email"
              type="email"
              inputMode="email"
              autoComplete="off"
              placeholder={t("outcomeControl.emailPlaceholder")}
              className="h-11 text-base"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                setError(null);
                setDone(null);
              }}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="outcome-mode">{t("outcomeControl.mode")}</Label>
            <select
              id="outcome-mode"
              className={selectClass}
              value={mode}
              onChange={(e) => {
                setMode(e.target.value as OutcomeMode);
                setError(null);
                setDone(null);
              }}
            >
              {OUTCOME_MODES.map((m) => (
                <option key={m} value={m}>
                  {t(`outcomeControl.${LABEL[m]}`)}
                </option>
              ))}
            </select>
          </div>
          <Button type="submit" className="h-11" disabled={!valid || pending}>
            {pending ? t("outcomeControl.applying") : t("outcomeControl.applyOverride")}
          </Button>
        </div>

        {mode === "controlled" ? (
          <div className="space-y-2 rounded-lg border bg-background/40 p-3">
            <div className="flex items-center justify-between text-sm">
              <span className="font-medium">{t("outcomeControl.winRate")}</span>
              <span className="tabular-nums text-muted-foreground">
                {t("outcomeControl.winLossSplit", { win: rate, loss: 100 - rate })}
              </span>
            </div>
            <Slider min={0} max={100} step={1} value={[rate]} onValueChange={(v) => setRate(v[0] ?? 0)} />
          </div>
        ) : null}

        <FormError message={error} />
        {done ? (
          <p role="status" className="text-sm text-up">
            {done}
          </p>
        ) : null}
      </form>
    </section>
  );
}

function OverrideList({ rows, onChanged }: { rows: OutcomeOverride[]; onChanged: () => void }) {
  const t = useTranslations("Admin");
  return (
    <section className="space-y-3 rounded-xl border bg-card p-4">
      <h2 className="font-medium">{t("outcomeControl.overrides", { count: rows.length })}</h2>
      {rows.length === 0 ? <p className="text-sm text-muted-foreground">{t("outcomeControl.noOverrides")}</p> : null}
      <ul className="space-y-2">
        {rows.map((row) => (
          <li key={row.userId}>
            <OverrideRow row={row} onChanged={onChanged} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function OverrideRow({ row, onChanged }: { row: OutcomeOverride; onChanged: () => void }) {
  const t = useTranslations("Admin");
  const rpcMessage = useRpcMessage();
  const attempt = useAttemptKey();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function clear() {
    if (pending) return;
    setPending(true);
    setError(null);
    const key = attempt.keyFor(`clear|${row.userId}`);
    const { error } = await createClient().rpc("admin_clear_outcome_override", {
      p_user_id: row.userId,
      p_client_request_id: key,
    });
    setPending(false);
    if (error) {
      if (serverAnswered(error)) attempt.settle();
      setError(rpcMessage(error));
      return;
    }
    attempt.settle();
    onChanged();
  }

  return (
    <div className="flex items-start justify-between gap-3 rounded-lg border bg-background/40 px-3 py-2">
      <div className="min-w-0 space-y-0.5">
        <p className="truncate text-sm font-medium">{row.email ?? row.userId}</p>
        <p className="text-xs text-muted-foreground">
          {t(`outcomeControl.${LABEL[row.mode]}`)}
          {row.mode === "controlled"
            ? ` · ${t("outcomeControl.winLossSplit", { win: row.winRatePct, loss: 100 - row.winRatePct })}`
            : null}
        </p>
        <FormError message={error} />
      </div>
      <Button type="button" variant="secondary" className="h-9 shrink-0" disabled={pending} onClick={() => void clear()}>
        {pending ? t("outcomeControl.clearing") : t("outcomeControl.clear")}
      </Button>
    </div>
  );
}
