"use client";

import { MotionConfig } from "motion/react";

// One MotionConfig for the whole app: under prefers-reduced-motion, motion components keep
// their opacity fades and drop transform animations (movement and scale).
export function MotionProvider({ children }: { children: React.ReactNode }) {
  return <MotionConfig reducedMotion="user">{children}</MotionConfig>;
}
