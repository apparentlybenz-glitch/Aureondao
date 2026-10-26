import { Suspense } from "react";
import { MarketScreen } from "@/components/market/market-screen";

export default function Page() {
  return (
    <Suspense fallback={null}>
      <MarketScreen />
    </Suspense>
  );
}
