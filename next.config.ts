import type { NextConfig } from "next";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
import { withSentryConfig } from "@sentry/nextjs/config";
import createNextIntlPlugin from "next-intl/plugin";

const nextConfig: NextConfig = {
  // Cloudflare Images binding is not configured; serve images as-is.
  images: { unoptimized: true },
  // No on-disk Turbopack cache for builds: Workers Builds restores .next/cache between
  // deploys, and a restored cache once shipped a stale globals.css (no splash or skeleton CSS).
  experimental: { turbopackFileSystemCacheForBuild: false },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

// Source maps upload only when SENTRY_AUTH_TOKEN is set. No tunnelRoute:
// it would send every browser event through the Worker.
export default withSentryConfig(withNextIntl(nextConfig), {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  silent: !process.env.CI,
});

initOpenNextCloudflareForDev();
