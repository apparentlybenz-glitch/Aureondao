"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Share2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { notify } from "@/lib/notify";
import { capturePng, sharePng, whatsappUrl } from "@/lib/share-image";
import type { ShareTrade } from "@/lib/share-trade";
import { ShareCard } from "./share-card";

// Share icon for one settled trade. The card is mounted off screen only while it is captured.
export function ShareButton({ trade }: { trade: ShareTrade }) {
  const t = useTranslations("Share");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const text = t("text", { percent: trade.percent, pair: trade.pair });

  useEffect(() => {
    const node = cardRef.current;
    if (!busy || !node) return;
    (async () => {
      try {
        const blob = await capturePng(node);
        setSaved((await sharePng(blob, "aureonx-result.png", text)) === "downloaded");
      } catch {
        notify({ title: t("failed") });
      } finally {
        setBusy(false);
      }
    })();
  }, [busy, text, t]);

  return (
    <>
      <button
        type="button"
        aria-label={t("share")}
        disabled={busy}
        onClick={() => {
          setSaved(false);
          setBusy(true);
        }}
        className="flex size-8 items-center justify-center rounded-full border text-muted-foreground disabled:opacity-60"
      >
        <Share2 className="size-4" />
      </button>
      {saved ? (
        <a href={whatsappUrl(text)} target="_blank" rel="noopener noreferrer" className="text-xs font-medium text-primary">
          {t("whatsapp")}
        </a>
      ) : null}
      {busy
        ? createPortal(
            <div aria-hidden="true" className="pointer-events-none fixed -left-[10000px] top-0">
              <div ref={cardRef}>
                <ShareCard trade={trade} />
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
