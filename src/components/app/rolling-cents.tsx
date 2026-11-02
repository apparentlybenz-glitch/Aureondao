"use client";

import { useEffect } from "react";
import { animate, motion, useMotionValue, useReducedMotion, useTransform } from "motion/react";
import { formatCents } from "@/lib/money";
import { EASE_OUT } from "@/lib/motion";

// A displayed balance. When the amount changes while it is on screen (an order, a transfer, an
// admin credit), the number counts from the old amount to the new one over 600 ms and ends on
// the exact formatted amount; a fresh mount shows the amount as it is. Display only: the value
// passed in is never changed. No tween under reduced motion or beyond the exact range of a
// float (then it jumps).
export function RollingCents({ cents }: { cents: bigint }) {
  const reduce = useReducedMotion();
  const value = useMotionValue(Number(cents));
  const text = useTransform(value, (v) => formatCents(BigInt(Math.round(v))));

  useEffect(() => {
    const target = Number(cents);
    if (value.get() === target) return;
    if (reduce || !Number.isSafeInteger(target)) {
      value.jump(target);
      return;
    }
    const controls = animate(value, target, {
      duration: 0.6,
      ease: EASE_OUT,
      onComplete: () => value.jump(target),
    });
    return () => controls.stop();
  }, [cents, reduce, value]);

  return <motion.span>{text}</motion.span>;
}
