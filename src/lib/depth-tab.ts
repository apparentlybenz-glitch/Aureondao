// After a successful order the depth panel moves from Book to Trades, so the user sees the
// market trade list. Any other tab stays where it is. Nothing is stored.
export function tabAfterOrder<T extends string>(tab: T): T | "trades" {
  return tab === "book" ? "trades" : tab;
}
