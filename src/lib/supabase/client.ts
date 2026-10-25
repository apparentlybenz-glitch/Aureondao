import { createBrowserClient } from "@supabase/ssr";
import { supabasePublishableKey, supabaseUrl } from "./env";

// Browser client: all reads (under RLS), RPC writes and Realtime go through this.
export function createClient() {
  return createBrowserClient(supabaseUrl, supabasePublishableKey);
}
