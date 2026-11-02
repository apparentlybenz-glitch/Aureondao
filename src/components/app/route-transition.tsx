"use client";

import { useContext, useState } from "react";
import { usePathname, useSelectedLayoutSegment } from "next/navigation";
// Next internal, not a public API. Tested with Next 16.4.3: recheck this import and the
// exit freeze below on every Next upgrade.
import { LayoutRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { AnimatePresence, motion, useIsPresent } from "motion/react";
import { EASE_OUT } from "@/lib/motion";

// Keeps a leaving route on screen during its exit. While present it passes the live router
// context through; once AnimatePresence marks it as leaving, it keeps serving the last live
// context, so the leaving copy keeps rendering the old route instead of the new one.
function FrozenRouter({ children }: { children: React.ReactNode }) {
  const context = useContext(LayoutRouterContext);
  const present = useIsPresent();
  const [frozen, setFrozen] = useState(context);
  if (present && frozen !== context) setFrozen(context);
  return <LayoutRouterContext.Provider value={present ? context : frozen}>{children}</LayoutRouterContext.Provider>;
}

// First path segments the tab bar and the desktop top bar switch between: these swaps fade only,
// faster, so a tab switch feels instant.
const TABS = new Set(["home", "market", "spot", "options", "forex", "assets", "account"]);
const firstSegment = (path: string) => path.split("/")[1] ?? "";

type Variant = "route" | "fade";
type Custom = { variant: Variant; tab: boolean };

// route: enter rises 8 px and fades in over 200 ms, exit fades out over 120 ms with no movement;
// a tab switch fades only, 120 ms in and 80 ms out. fade (tab content inside a layout): opacity
// only, 120 ms in and 80 ms out. Reduced motion drops the rise (MotionProvider).
const variants = {
  hidden: ({ variant, tab }: Custom) => (variant === "route" && !tab ? { opacity: 0, y: 8 } : { opacity: 0, y: 0 }),
  shown: ({ variant, tab }: Custom) => ({
    opacity: 1,
    y: 0,
    transition: { duration: variant === "route" && !tab ? 0.2 : 0.12, ease: EASE_OUT },
  }),
  exit: ({ variant, tab }: Custom) => ({
    opacity: 0,
    transition: { duration: variant === "route" && !tab ? 0.12 : 0.08, ease: EASE_OUT },
  }),
};

// Animates the route below the layout it sits in, on enter and exit (mode "wait"). keyBy
// "segment" replays only when this layout's child segment changes (so /account to
// /account/profile does not replay the outer one); "path" replays on every pathname change.
// Nothing on first load (the splash covers it). Scrolls to the top once the exit finishes.
export function RouteTransition({
  children,
  keyBy,
  variant = "route",
  className,
}: {
  children: React.ReactNode;
  keyBy: "segment" | "path";
  variant?: Variant;
  className?: string;
}) {
  const pathname = usePathname();
  const segment = useSelectedLayoutSegment();
  const key = keyBy === "path" ? pathname : (segment ?? "");
  const [paths, setPaths] = useState({ current: pathname, previous: pathname });
  if (paths.current !== pathname) setPaths({ current: pathname, previous: paths.current });
  const custom: Custom = {
    variant,
    tab: TABS.has(firstSegment(paths.previous)) && TABS.has(firstSegment(pathname)),
  };

  return (
    <AnimatePresence mode="wait" initial={false} custom={custom} onExitComplete={() => window.scrollTo(0, 0)}>
      <motion.div
        key={key}
        custom={custom}
        variants={variants}
        initial="hidden"
        animate="shown"
        exit="exit"
        className={className}
      >
        <FrozenRouter>{children}</FrozenRouter>
      </motion.div>
    </AnimatePresence>
  );
}
