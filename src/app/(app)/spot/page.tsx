import { Suspense } from "react";
import { SpotTerminal } from "@/components/spot/spot-terminal";

// Full-screen terminal: it sits directly in (app), so it has the tab bar but
// its own header instead of the top bar. useSearchParams needs the Suspense.
export default function Page() {
  return (
    <Suspense fallback={null}>
      <SpotTerminal />
    </Suspense>
  );
}
