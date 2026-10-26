import { OptionsTerminal } from "@/components/options/options-terminal";

// Full-screen terminal like Spot: it sits directly in (app), so it keeps the
// tab bar (Options active) but has its own header instead of the top bar.
export default function Page() {
  return <OptionsTerminal />;
}
