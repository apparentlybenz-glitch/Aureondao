import type { MetadataRoute } from "next";
import messages from "../../messages/en.json";

// Static web app manifest, served at /manifest.webmanifest. "any" and "maskable"
// icons are separate entries: a combined purpose would crop the any icons.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "AureonX",
    short_name: "AureonX",
    id: "/",
    scope: "/",
    description: messages.Metadata.description,
    start_url: "/home",
    display: "standalone",
    background_color: "#151a18",
    theme_color: "#151a18",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
