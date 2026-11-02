"use client";

import { useRef } from "react";
import { X } from "lucide-react";
import { Dialog } from "radix-ui";
import { AnimatePresence, animate, motion, useDragControls, useIsPresent, useMotionValue, useReducedMotion } from "motion/react";
import { EASE_DRAWER, EASE_OUT } from "@/lib/motion";
import { cn } from "@/lib/utils";

// Enter from the bottom edge over 320 ms, leave by the same edge over 220 ms. A drag released
// short of the dismiss point springs back. Reduced motion: a fade, no travel and no drag.
const ENTER = { duration: 0.32, ease: EASE_DRAWER } as const;
const EXIT = { duration: 0.22, ease: EASE_DRAWER } as const;
const SPRING_BACK = { type: "spring", duration: 0.4, bounce: 0.15 } as const;
const OVERLAY = { duration: 0.2, ease: EASE_OUT } as const;
// Close when the drag passes this share of the sheet height, or on a downward flick.
const DISMISS_SHARE = 0.3;
const DISMISS_VELOCITY = 500; // px/s
// Resistance when pulled above its resting place.
const TOP_ELASTIC = 0.1;

// A Radix Dialog bottom sheet: the trigger, then a panel with a grab handle and a header (title
// and close). Dragging the handle or the header down dismisses it; the body scrolls on its own.
// The panel stays mounted through its exit (AnimatePresence) and takes no taps while leaving.
export function Sheet({
  open,
  onOpenChange,
  trigger,
  title,
  closeLabel,
  className,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger: React.ReactNode;
  title: string;
  closeLabel: string;
  // Size and padding of the panel (height, bottom padding).
  className?: string;
  children: React.ReactNode;
}) {
  const reduce = useReducedMotion();
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Trigger asChild>{trigger}</Dialog.Trigger>
      <AnimatePresence>
        {open ? (
          <Dialog.Portal forceMount>
            <Dialog.Overlay forceMount asChild>
              <motion.div
                className="fixed inset-0 z-50 bg-black/60"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1, transition: OVERLAY }}
                exit={{ opacity: 0, transition: OVERLAY }}
              />
            </Dialog.Overlay>
            <Panel
              reduce={!!reduce}
              title={title}
              closeLabel={closeLabel}
              onClose={() => onOpenChange(false)}
              className={className}
            >
              {children}
            </Panel>
          </Dialog.Portal>
        ) : null}
      </AnimatePresence>
    </Dialog.Root>
  );
}

function Panel({
  reduce,
  title,
  closeLabel,
  onClose,
  className,
  children,
}: {
  reduce: boolean;
  title: string;
  closeLabel: string;
  onClose: () => void;
  className?: string;
  children: React.ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const controls = useDragControls();
  const y = useMotionValue(0);
  const present = useIsPresent();
  const hidden = reduce ? { opacity: 0 } : { y: "100%" };
  return (
    <Dialog.Content forceMount asChild aria-describedby={undefined}>
      <motion.div
        ref={panel}
        // Radix sets pointer-events auto on the panel (the body gets none); keep that while present.
        style={{ y, pointerEvents: present ? "auto" : "none" }}
        initial={hidden}
        animate={reduce ? { opacity: 1, transition: ENTER } : { y: 0, transition: ENTER }}
        exit={{ ...hidden, transition: EXIT }}
        drag={reduce ? false : "y"}
        dragListener={false}
        dragControls={controls}
        dragConstraints={{ top: 0, bottom: 0 }}
        dragElastic={{ top: TOP_ELASTIC, bottom: 1 }}
        dragMomentum={false}
        onDragEnd={(_, info) => {
          const height = panel.current?.offsetHeight ?? 0;
          if (info.offset.y > height * DISMISS_SHARE || info.velocity.y > DISMISS_VELOCITY) onClose();
          // Runs after motion's own release animation starts, so this spring replaces it.
          else animate(y, 0, SPRING_BACK);
        }}
        className={cn(
          "fixed inset-x-0 bottom-0 z-50 mx-auto flex max-w-[880px] flex-col rounded-t-2xl border-t bg-background",
          className,
        )}
      >
        <div onPointerDown={(e) => controls.start(e)} className="shrink-0 touch-none select-none">
          <div aria-hidden="true" className="mx-auto mt-2 h-1 w-9 rounded-full bg-muted-foreground/40" />
          <div className="flex items-center justify-between px-4 pt-1 pb-2">
            <Dialog.Title className="text-base font-semibold">{title}</Dialog.Title>
            <Dialog.Close aria-label={closeLabel} className="flex size-9 items-center justify-center rounded-full">
              <X className="size-5" />
            </Dialog.Close>
          </div>
        </div>
        {children}
      </motion.div>
    </Dialog.Content>
  );
}
