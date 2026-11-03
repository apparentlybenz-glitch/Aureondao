import { useTranslations } from "next-intl";
import { BrandMark } from "@/components/brand/brand-mark";
import { Wordmark } from "@/components/brand/wordmark";
import { CoinIcon } from "@/components/market/coin-icon";
import type { ShareTrade } from "@/lib/share-trade";

export const SHARE_CARD_WIDTH = 360;

// Green orbit ring drawn behind the mark: three tilted ellipses and a few stars.
function OrbitRing() {
  return (
    <svg viewBox="0 0 360 160" aria-hidden="true" className="absolute inset-x-0 top-0 h-40 w-full">
      <g fill="none" stroke="#1BA04A" strokeLinecap="round">
        <ellipse cx="180" cy="80" rx="150" ry="46" strokeWidth="1.5" opacity="0.55" transform="rotate(-12 180 80)" />
        <ellipse cx="180" cy="80" rx="120" ry="34" strokeWidth="1" opacity="0.35" transform="rotate(-12 180 80)" />
        <ellipse cx="180" cy="80" rx="176" ry="60" strokeWidth="0.75" opacity="0.2" transform="rotate(-12 180 80)" />
      </g>
      <g fill="#1BA04A">
        <circle cx="46" cy="104" r="2.5" />
        <circle cx="312" cy="52" r="2" />
        <circle cx="286" cy="124" r="1.5" />
        <circle cx="74" cy="38" r="1.5" />
      </g>
    </svg>
  );
}

// The 360 px card captured to a PNG. Colors are literal so the capture does not depend on theme tokens,
// and the textured background is gradients only, so nothing is fetched.
export function ShareCard({ trade }: { trade: ShareTrade }) {
  const t = useTranslations("Share");
  const tone = trade.win ? "#2fd47a" : "#e5484d";

  return (
    <div
      style={{
        width: SHARE_CARD_WIDTH,
        backgroundColor: "#080c0a",
        backgroundImage:
          `radial-gradient(circle at 50% 0%, ${trade.win ? "rgba(27,160,74,0.28)" : "rgba(229,72,77,0.18)"}, transparent 60%), ` +
          "repeating-linear-gradient(0deg, rgba(255,255,255,0.035) 0 1px, transparent 1px 24px), " +
          "repeating-linear-gradient(90deg, rgba(255,255,255,0.035) 0 1px, transparent 1px 24px)",
        color: "#f2f5f3",
        // The card ignores the theme: no disc behind white-only coin logos, as in the dark theme.
        ["--coin-backing-white" as string]: "transparent",
      }}
      className="relative overflow-hidden rounded-2xl border border-white/10 px-6 py-6"
    >
      <OrbitRing />
      <div className="relative flex flex-col items-center">
        <BrandMark variant="full" idPrefix="share" size={72} />
        <Wordmark literal className="mt-3 h-5" />
      </div>

      <div className="relative mt-8 text-center">
        <p style={{ color: tone }} className="text-5xl font-bold tabular-nums">
          {trade.percent}
        </p>
        <p style={{ color: tone }} className="mt-1 text-lg font-semibold tabular-nums">
          {t("card.amount", { amount: trade.amount })}
        </p>
      </div>

      <div className="relative mt-8">
        <p className="flex items-center gap-2 text-lg font-semibold">
          <CoinIcon symbol={trade.base} size={28} eager />
          {trade.pair}
        </p>
        <p className="mt-1 text-sm" style={{ color: "#9aa8a0" }}>
          {t(`card.${trade.side}`)} | {t("card.seconds", { seconds: trade.durationS })} | {t(`card.${trade.product}`)}
        </p>
        <dl className="mt-4 space-y-2 text-sm tabular-nums">
          <div className="flex justify-between">
            <dt style={{ color: "#9aa8a0" }}>{t("card.premium")}</dt>
            <dd className="font-medium">{trade.premium}</dd>
          </div>
          <div className="flex justify-between">
            <dt style={{ color: "#9aa8a0" }}>{t("card.strike")}</dt>
            <dd className="font-medium">{trade.strike}</dd>
          </div>
        </dl>
      </div>
    </div>
  );
}
