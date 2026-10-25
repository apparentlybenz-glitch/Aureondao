import { defineCloudflareConfig } from "@opennextjs/cloudflare";
import staticAssetsIncrementalCache from "@opennextjs/cloudflare/overrides/incremental-cache/static-assets-incremental-cache";

// Public pages are fully static (no ISR), so a read-only cache backed by
// Workers Static Assets is enough. No R2/KV/D1/Queue bindings needed.
export default defineCloudflareConfig({
  incrementalCache: staticAssetsIncrementalCache,
});
