import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getTranslations } from "next-intl/server";
import { MotionProvider } from "@/components/app/motion-provider";
import { Splash } from "@/components/app/splash";
import { CookieConsent } from "@/components/legal/cookie-consent";
import { RegisterServiceWorker } from "@/components/offline/register-sw";
import { THEME_COLORS, THEME_SCRIPT } from "@/lib/theme";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// Base for Open Graph image URLs. Used only when NEXT_PUBLIC_SITE_URL is set and
// is a valid URL; otherwise it stays unset.
function siteUrl(): URL | undefined {
  const value = process.env.NEXT_PUBLIC_SITE_URL;
  if (!value) return undefined;
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Metadata");
  return {
    metadataBase: siteUrl(),
    title: t("title"),
    description: t("description"),
    appleWebApp: { capable: true, title: t("title"), statusBarStyle: "black" },
  };
}

export const viewport: Viewport = { themeColor: THEME_COLORS.dark, viewportFit: "cover" };

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const locale = await getLocale();

  return (
    // THEME_SCRIPT swaps the class on <html> before first paint, so the attribute can differ from
    // the server HTML (dark is the default).
    <html
      lang={locale}
      suppressHydrationWarning
      className={`dark ${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="min-h-full flex flex-col">
        <NextIntlClientProvider>
          <MotionProvider>
            {children}
            <CookieConsent />
          </MotionProvider>
          <Splash />
        </NextIntlClientProvider>
        <RegisterServiceWorker />
      </body>
    </html>
  );
}
