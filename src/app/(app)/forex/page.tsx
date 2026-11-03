import { Suspense } from "react";
import { ForexTerminal } from "@/components/forex/forex-terminal";

// Same shell as Options: directly in (app), so the tab bar stays and the page
// has its own header instead of the top bar. useSearchParams needs the Suspense.
export default function Page() {
  return (
    <Suspense fallback={null}>
      <ForexTerminal />
    </Suspense>
  );
}
