// Options ticket math, all on integer cents (BigInt) and integer basis points.
// The server recomputes everything; these only drive the ticket's display.
const BPS = BigInt(10000);

// Profit shown before opening: floor(premium x rate / 10000), as the server pays on a win.
export function estReturnCents(premiumCents: bigint, profitRateBps: number): bigint {
  return (premiumCents * BigInt(profitRateBps)) / BPS;
}

// 600 -> "6%", 10 -> "0.1%", 650 -> "6.5%", 1 -> "0.01%".
export function bpsToPercent(bps: number): string {
  const whole = Math.trunc(bps / 100);
  const fraction = (bps % 100).toString().padStart(2, "0").replace(/0+$/, "");
  return `${whole}${fraction ? `.${fraction}` : ""}%`;
}

// Milliseconds left -> "m:ss", rounded up so "0:00" shows only at expiry.
export function formatCountdown(remainingMs: number): string {
  const total = Math.max(0, Math.ceil(remainingMs / 1000));
  return `${Math.floor(total / 60)}:${(total % 60).toString().padStart(2, "0")}`;
}
