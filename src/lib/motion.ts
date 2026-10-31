// Motion tokens for components that animate through the motion library, which cannot read CSS
// variables. globals.css is the source of truth: these mirror only the values motion components
// use. Add a value here when a component needs it, not before.

// --ease-out-strong
export const EASE_OUT = [0.23, 1, 0.32, 1] as const;

// --duration-fast, --duration-base and --duration-moderate, in seconds.
export const DURATION = { fast: 0.12, base: 0.15, moderate: 0.2 } as const;
