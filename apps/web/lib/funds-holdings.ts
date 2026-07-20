/**
 * Pure logic for the connected-wallet holdings scan behind the deposit picker:
 * which EVM tokens to read per chain, the multicall contract shaping, and
 * folding raw balances into a sorted, USD-valued holdings list (Polymarket's
 * "here's what you hold" deposit screen).
 *
 * No React/wagmi here so it's unit-testable like `funds-assets.ts`; the thin
 * `use-wallet-holdings` hook feeds this the six chains' multicall results.
 */
import { erc20Abi, formatUnits, multicall3Abi } from "viem";
import { isNativePlaceholder, isStableSymbol, symbolGroup } from "./funds-assets";
import type { FundsAsset } from "./types";

/** EVM chains whose connected-wallet balances we scan, in display order. */
export const BALANCE_CHAIN_IDS = ["1", "8453", "42161", "137", "10", "56"] as const;
export type BalanceChainId = (typeof BALANCE_CHAIN_IDS)[number];

/** Multicall3 — same address on every supported EVM chain; carries getEthBalance. */
export const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;

const CHAIN_ORDER: Record<string, number> = Object.fromEntries(
  BALANCE_CHAIN_IDS.map((id, i) => [id, i]),
);

/** Scan priority so the per-chain cap keeps the assets people actually deposit. */
const GROUP_PRIORITY: Record<string, number> = {
  USDC: 0,
  USDT: 1,
  DAI: 2,
  ETH: 3,
  WETH: 3,
  WBTC: 4,
  POL: 5,
  BNB: 6,
};
const groupPriority = (group: string): number => GROUP_PRIORITY[group] ?? 50;

/** One token on one EVM chain we will read `balanceOf` (or native balance) for. */
export interface ScanToken {
  asset: FundsAsset;
  group: string;
  isNative: boolean;
  /** ERC-20 contract; undefined for the native coin. */
  address?: `0x${string}`;
  decimals: number;
}

/** One EVM chain's scan inputs + aligned raw results (null = read failed/absent). */
export interface ChainScan {
  chainId: string;
  tokens: ScanToken[];
  balances: (bigint | null)[];
}

export interface WalletHolding {
  /** Stable selection id, `${group}:${chainId}`. */
  key: string;
  group: string;
  /** The concrete variant's symbol (may be "USDC.e"); the UI shows `group`. */
  symbol: string;
  chainId: string;
  chainName: string;
  /** The catalog entry the send flow targets (the variant actually held). */
  asset: FundsAsset;
  amount: number;
  decimals: number;
  /** USD value; null when the price is unknown (volatile asset, no feed). */
  usd: number | null;
}

/**
 * The EVM tokens to read on one chain. Keeps EVERY listed variant (USDC and
 * USDC.e both) — folding to canonical happens after balances are known, so a
 * user holding only USDC.e is still seen and the zero-fee Polygon route fires.
 * Native is always kept (sorted first, survives the cap); the rest are ordered
 * by deposit popularity then minimum, and capped to bound the multicall.
 */
export function evmTokensForChain(assets: FundsAsset[], chainId: string, cap = 24): ScanToken[] {
  const seen = new Set<string>();
  const tokens: ScanToken[] = [];
  for (const asset of assets) {
    if (asset.chainId !== chainId || asset.addressType !== "evm") continue;
    const native = isNativePlaceholder(asset.token.address);
    const dedupeKey = native ? "native" : asset.token.address.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    tokens.push({
      asset,
      group: symbolGroup(asset.token.symbol),
      isNative: native,
      address: native ? undefined : (asset.token.address as `0x${string}`),
      // getEthBalance always returns wei — never trust a stray catalog decimals.
      decimals: native ? 18 : asset.token.decimals,
    });
  }
  return tokens
    .sort(
      (a, b) =>
        Number(b.isNative) - Number(a.isNative) ||
        groupPriority(a.group) - groupPriority(b.group) ||
        a.asset.minCheckoutUsd - b.asset.minCheckoutUsd,
    )
    .slice(0, cap);
}

/** wagmi `contracts` array for one chain's scan — aligned index-for-index with
 * `tokens` so results zip back cleanly. Native → Multicall3 `getEthBalance`.
 * `useReadContracts` carries chainId per contract (no top-level chainId), so it
 * is stamped on every entry. */
export function scanContracts(tokens: ScanToken[], holder: `0x${string}`, chainId: number) {
  return tokens.map((token) =>
    token.isNative
      ? {
          chainId,
          address: MULTICALL3_ADDRESS,
          abi: multicall3Abi,
          functionName: "getEthBalance" as const,
          args: [holder] as const,
        }
      : {
          chainId,
          address: token.address!,
          abi: erc20Abi,
          functionName: "balanceOf" as const,
          args: [holder] as const,
        },
  );
}

/** Price-map key for a token symbol: wrapped variants fold to their base coin. */
export function priceKeyFor(symbol: string): string {
  const group = symbolGroup(symbol);
  const base: Record<string, string> = {
    WETH: "ETH",
    WBTC: "BTC",
    WMATIC: "POL",
    WPOL: "POL",
    WBNB: "BNB",
    WSOL: "SOL",
  };
  return base[group] ?? group;
}

const holdingUsd = (symbol: string, amount: number, prices: Record<string, number>): number | null => {
  if (isStableSymbol(symbol)) return amount; // 1 token ≈ $1
  const price = prices[priceKeyFor(symbol)];
  return typeof price === "number" && price > 0 ? amount * price : null;
};

/**
 * Symbols that denote the same underlying asset and must fold to one row. POL
 * and MATIC are the same Polygon coin (post-rename; the Bridge lists both, and
 * the native coin is also readable via the 0x…1010 predeploy), so a wallet
 * would otherwise show its balance twice.
 */
const GROUP_ALIAS: Record<string, string> = { MATIC: "POL", WMATIC: "POL" };
const canonicalGroup = (group: string): string => GROUP_ALIAS[group] ?? group;

/** Below this a holding is dust — hidden so the list stays "real assets only". */
const DUST_USD = 0.01;
const DUST_AMOUNT = 1e-4;

/** When folding variants of one asset, prefer a priced entry, then the larger balance. */
const preferHolding = (cand: WalletHolding, existing: WalletHolding): boolean => {
  const candPriced = cand.usd != null;
  const exPriced = existing.usd != null;
  if (candPriced !== exPriced) return candPriced;
  return cand.amount > existing.amount;
};

/**
 * Fold the six chains' raw balances into a sorted holdings list. Positive
 * balances only; variants of one asset on one chain collapse to a single row
 * keyed by (canonical group, chain) — USDC≡USDC.e, POL≡MATIC — keeping the
 * priced/larger variant as the send target. Dust (sub-cent, or a sub-epsilon
 * unpriced amount) is dropped. Sorted by USD desc (unknown price last), then
 * amount, then chain order.
 */
export function buildHoldings(
  scans: ChainScan[],
  prices: Record<string, number>,
): WalletHolding[] {
  const byKey = new Map<string, WalletHolding>();
  for (const scan of scans) {
    scan.tokens.forEach((token, i) => {
      const raw = scan.balances[i];
      if (raw == null || raw <= 0n) return;
      const amount = Number(formatUnits(raw, token.decimals));
      if (!(amount > 0)) return;
      const group = canonicalGroup(token.group);
      const key = `${group}:${scan.chainId}`;
      const cand: WalletHolding = {
        key,
        group,
        symbol: token.asset.token.symbol,
        chainId: scan.chainId,
        chainName: token.asset.chainName,
        asset: token.asset,
        amount,
        decimals: token.decimals,
        usd: holdingUsd(token.asset.token.symbol, amount, prices),
      };
      const existing = byKey.get(key);
      if (!existing || preferHolding(cand, existing)) byKey.set(key, cand);
    });
  }
  return [...byKey.values()]
    .filter((h) => (h.usd != null ? h.usd >= DUST_USD : h.amount >= DUST_AMOUNT))
    .sort(
      (a, b) =>
        (b.usd ?? -1) - (a.usd ?? -1) ||
        b.amount - a.amount ||
        (CHAIN_ORDER[a.chainId] ?? 99) - (CHAIN_ORDER[b.chainId] ?? 99),
    );
}
