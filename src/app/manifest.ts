import type { MetadataRoute } from "next";

// Static web app manifest, served at /manifest.webmanifest. "any" and "maskable"
// icons are separate entries: a combined purpose would crop the any icons.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "AureonX",
    short_name: "AureonX",
    start_url: "/",
    display: "standalone",
    background_color: "#050505",
    theme_color: "#050505",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
