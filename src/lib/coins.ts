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

// Minimum deposit per supported asset and network, shown in the landing FAQ.
// `min` is a decimal string in units of `symbol`. The FAQ table reads only this.
export const DEPOSIT_MINIMUMS = [
  { id: "usdtTrc20", symbol: "USDT", network: "trc20", min: "10" },
  { id: "usdtErc20", symbol: "USDT", network: "erc20", min: "50" },
  { id: "btc", symbol: "BTC", network: "bitcoin", min: "0.0005" },
  { id: "sol", symbol: "SOL", network: "solana", min: "0.1" },
  { id: "eth", symbol: "ETH", network: "erc20", min: "0.01" },
  { id: "usdcErc20", symbol: "USDC", network: "erc20", min: "50" },
] as const satisfies readonly { id: string; symbol: CoinSymbol; network: NetworkKey; min: string }[];

export type DepositMinimumId = (typeof DEPOSIT_MINIMUMS)[number]["id"];
