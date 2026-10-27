// Options ticket math, all on integer cents (BigInt) and integer basis points.
// The server recomputes everything; these only drive the ticket's display.
const BPS = BigInt(10000);

// Profit shown before opening: floor(premium x rate / 10000), as the server pays on a win.
export function estReturnCents(premiumCents: bigint, profitRateBps: number): bigint {
  return (premiumCents * BigInt(profitRateBps)) / BPS;
}

// 600 -> "6", 10 -> "0.1", 650 -> "6.5", 1 -> "0.01" (the percent without its sign).
export function bpsToPercentText(bps: number): string {
  const whole = Math.trunc(bps / 100);
  const fraction = (bps % 100).toString().padStart(2, "0").replace(/0+$/, "");
  return `${whole}${fraction ? `.${fraction}` : ""}`;
}

// 600 -> "6%", 10 -> "0.1%", 650 -> "6.5%", 1 -> "0.01%".
export function bpsToPercent(bps: number): string {
  return `${bpsToPercentText(bps)}%`;
}

// "6" -> 600, "0.1" -> 10, "6.5" -> 650. At most 4 integer digits and 2 decimals,
// so every value is a whole number of basis points; anything else -> null.
export function percentToBps(input: string): number | null {
  const match = /^(\d{1,4})(?:\.(\d{1,2}))?$/.exec(input.trim());
  if (!match) return null;
  return Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
}

// Milliseconds left -> "m:ss", rounded up so "0:00" shows only at expiry.
export function formatCountdown(remainingMs: number): string {
  const total = Math.max(0, Math.ceil(remainingMs / 1000));
  return `${Math.floor(total / 60)}:${(total % 60).toString().padStart(2, "0")}`;
}
