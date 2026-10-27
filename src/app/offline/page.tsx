import { useTranslations } from "next-intl";
import { BrandMark } from "@/components/brand/brand-mark";

// Static page the service worker serves when a navigation fails offline. It is
// the only page cached, and the stylesheet and scripts under /_next are not, so
// it styles itself inline and reloads with a tiny inline script.
export default function OfflinePage() {
  const t = useTranslations("Offline");
  return (
    <main
      style={{
        position: "fixed",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 12,
        padding: 16,
        textAlign: "center",
        background: "#050505",
        color: "#f5f5f5",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <BrandMark variant="full" idPrefix="offline" size={80} />
      <h1 style={{ fontSize: 20, margin: 0 }}>{t("title")}</h1>
      <p style={{ maxWidth: 320, margin: 0, fontSize: 14, color: "#a3a3a3" }}>{t("body")}</p>
      <button
        id="retry"
        type="button"
        style={{
          marginTop: 8,
          height: 40,
          padding: "0 16px",
          border: 0,
          borderRadius: 8,
          background: "#1ba04a",
          color: "#050505",
          fontSize: 14,
          fontWeight: 600,
        }}
      >
        {t("retry")}
      </button>
      <script
        dangerouslySetInnerHTML={{
          __html: 'document.getElementById("retry").addEventListener("click",function(){location.reload()})',
        }}
      />
    </main>
  );
}
