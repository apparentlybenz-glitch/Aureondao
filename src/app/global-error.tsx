"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";
import messages from "../../messages/en.json";

// Replaces the root layout, so no providers, fonts or Tailwind classes can be
// relied on: plain inline styles in the brand colors, strings read straight from
// en.json.
export default function GlobalError({
  error,
  reset,
}: Readonly<{ error: Error & { digest?: string }; reset: () => void }>) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  const t = messages.Pages;
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100dvh",
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
        <h1 style={{ fontSize: 20, margin: 0 }}>{t.errorTitle}</h1>
        <p style={{ maxWidth: 320, margin: 0, fontSize: 14, color: "#a3a3a3" }}>{t.errorBody}</p>
        <button
          type="button"
          onClick={reset}
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
          {t.retry}
        </button>
      </body>
    </html>
  );
}
