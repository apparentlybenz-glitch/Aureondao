// The coins and networks shown on Deposit and Withdraw. Display only: no address
// exists for any of them and nothing here reaches the database.
export const COINS = [
  { symbol: "BTC", networks: ["bitcoin"] },
  { symbol: "USDT", networks: ["trc20", "erc20"] },
  { symbol: "USDC", networks: ["erc20"] },
  { symbol: "ETH", networks: ["erc20"] },
  { symbol: "SOL", networks: ["solana"] },
] as const;

export type CoinSymbol = (typeof COINS)[number]["symbol"];
export type NetworkKey = (typeof COINS)[number]["networks"][number];
