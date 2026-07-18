/**
 * Pure helpers for the deposit asset picker: token-first grouping over the
 * Bridge's supported-assets catalog, popularity ordering, and resolution of a
 * (token, chain) selection to the concrete catalog entry used for quotes and
 * in-app sends.
 *
 * Any asset the Bridge lists is depositable by sending it to the generated
 * family address, so a "wrong" resolution here can never strand funds — it
 * only affects the displayed minimum and which contract the in-app send uses.
 */
import type { FundsAsset } from "./types";

// ── Polygon funding constants (shared by the funds sheet + send panel) ──────
export const POLYGON_CHAIN_ID = 137;
/** Bridged USDC.e on Polygon — the deposit wallet accepts it directly, free. */
export const USDC_E_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174" as const;
/** pUSD — what deposit wallets hold (the V2 exchanges' collateral, 1:1 USD;
 * INTEGRATION_VERIFIED §23). Withdrawals send pUSD. */
export const PUSD_ADDRESS = "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB" as const;

/** Chips shown before "More", in display order. */
export const POPULAR_GROUPS = ["USDC", "USDT", "ETH", "SOL", "BTC"] as const;

/**
 * Grouping key for a token symbol: bridged variants ("USDC.e") fold into the
 * canonical symbol so the picker reads "USDC on Polygon", not "USDC.e".
 */
export const symbolGroup = (symbol: string): string => symbol.replace(/\.e$/i, "").toUpperCase();

/** Chains ranked by how often people actually deposit from them. */
const CHAIN_RANK: Record<string, number> = {
  "1": 0, // Ethereum
  "8453": 1, // Base
  "42161": 2, // Arbitrum
  "137": 3, // Polygon
  "10": 4, // Optimism
  "56": 5, // BNB Smart Chain
  "1151111081099710": 6, // Solana
  "728126428": 7, // Tron
  "8253038": 8, // Bitcoin
};
const UNRANKED = 99;

export interface GroupChain {
  chainId: string;
  chainName: string;
  addressType: FundsAsset["addressType"];
  minCheckoutUsd: number;
  /** The group is this chain's native coin here (SOL on Solana, ETH on Base). */
  hasNative: boolean;
}

/**
 * Distinct chains carrying any variant of the group. Home chains — where the
 * Bridge lists the group as the native coin — come first, so "SOL" reads
 * Solana-first, not wrapped-SOL-on-Ethereum-first; popularity breaks ties.
 */
export const chainsForGroup = (assets: FundsAsset[], group: string): GroupChain[] => {
  const byChain = new Map<string, GroupChain>();
  for (const asset of assets) {
    if (symbolGroup(asset.token.symbol) !== group) continue;
    const native = isNativePlaceholder(asset.token.address);
    const existing = byChain.get(asset.chainId);
    if (existing) {
      existing.minCheckoutUsd = Math.min(existing.minCheckoutUsd, asset.minCheckoutUsd);
      existing.hasNative = existing.hasNative || native;
    } else {
      byChain.set(asset.chainId, {
        chainId: asset.chainId,
        chainName: asset.chainName,
        addressType: asset.addressType,
        minCheckoutUsd: asset.minCheckoutUsd,
        hasNative: native,
      });
    }
  }
  return [...byChain.values()].sort(
    (a, b) =>
      Number(b.hasNative) - Number(a.hasNative) ||
      (CHAIN_RANK[a.chainId] ?? UNRANKED) - (CHAIN_RANK[b.chainId] ?? UNRANKED) ||
      a.chainName.localeCompare(b.chainName),
  );
};

/** The Bridge lists native coins (ETH/SOL/BTC/POL/BNB) under this pseudo-address. */
export const isNativePlaceholder = (address: string): boolean =>
  address.toLowerCase() === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

/** True when 1 token ≈ $1, so a raw amount can be compared to a USD minimum. */
export const isStableSymbol = (symbol: string): boolean => {
  const group = symbolGroup(symbol);
  return group.includes("USD") || group === "DAI";
};

/**
 * Prefer the entry whose address matches the chain family's real format:
 * catalogs list duplicates (native SOL as both "0xEee…" and the system
 * program, BTC as "0xEee…" and "bc1…"), and quotes are most likely to succeed
 * against the family-native identifier.
 */
const familyFormatScore = (asset: FundsAsset): number => {
  if (asset.addressType === "evm") return 1; // everything it lists is 0x-style
  return asset.token.address.startsWith("0x") ? 0 : 1;
};

/**
 * Resolve a (group, chain) selection to one catalog entry. Preference:
 * exact canonical symbol > family-native address format > lower minimum.
 */
export const assetForSelection = (
  assets: FundsAsset[],
  group: string,
  chainId: string,
): FundsAsset | null => {
  const candidates = assets.filter(
    (asset) => asset.chainId === chainId && symbolGroup(asset.token.symbol) === group,
  );
  if (candidates.length === 0) return null;
  const score = (asset: FundsAsset): number =>
    (asset.token.symbol.toUpperCase() === group ? 4 : 0) + familyFormatScore(asset) * 2;
  return candidates.reduce((best, next) =>
    score(next) > score(best) ||
    (score(next) === score(best) && next.minCheckoutUsd < best.minCheckoutUsd)
      ? next
      : best,
  );
};

/**
 * Default chain for a group. Home chains win when they exist (clicking SOL
 * means Solana, BTC means Bitcoin); within the eligible set the connected
 * wallet's chain wins (clicking ETH while on Base means ETH on Base), then
 * popularity order.
 */
export const defaultChainFor = (
  chains: GroupChain[],
  connectedChainId: number | undefined,
): GroupChain | null => {
  if (chains.length === 0) return null;
  const eligible = chains.some((chain) => chain.hasNative)
    ? chains.filter((chain) => chain.hasNative)
    : chains;
  if (connectedChainId !== undefined) {
    const connected = eligible.find((chain) => chain.chainId === String(connectedChainId));
    if (connected) return connected;
  }
  return eligible[0] ?? null;
};

/** Full-catalog search for the "More" picker (symbol, name, or chain). */
export const searchAssets = (assets: FundsAsset[], query: string, limit = 60): FundsAsset[] => {
  const q = query.trim().toLowerCase();
  const rank = (asset: FundsAsset): number =>
    (CHAIN_RANK[asset.chainId] ?? UNRANKED) * 1000 + asset.minCheckoutUsd;
  const matches = q
    ? assets.filter(
        (asset) =>
          asset.token.symbol.toLowerCase().includes(q) ||
          asset.token.name.toLowerCase().includes(q) ||
          asset.chainName.toLowerCase().includes(q),
      )
    : assets;
  return [...matches]
    .sort((a, b) => {
      if (q) {
        const aPrefix = a.token.symbol.toLowerCase().startsWith(q) ? 0 : 1;
        const bPrefix = b.token.symbol.toLowerCase().startsWith(q) ? 0 : 1;
        if (aPrefix !== bPrefix) return aPrefix - bPrefix;
      }
      return (
        a.token.symbol.localeCompare(b.token.symbol) ||
        rank(a) - rank(b) ||
        a.chainName.localeCompare(b.chainName)
      );
    })
    .slice(0, limit);
};
