import { describe, it, expect } from "vitest";
import {
  assetForSelection,
  chainsForGroup,
  defaultChainFor,
  isNativePlaceholder,
  searchAssets,
  symbolGroup,
} from "./funds-assets";
import type { FundsAsset } from "./types";

const NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

const asset = (
  chainId: string,
  chainName: string,
  addressType: FundsAsset["addressType"],
  symbol: string,
  address: string,
  minCheckoutUsd = 2,
  name = symbol,
): FundsAsset => ({
  id: `${chainId}:${address.toLowerCase()}`,
  chainId,
  chainName,
  addressType,
  minCheckoutUsd,
  token: { name, symbol, address, decimals: 6 },
});

/** Subset of the real 2026-07 catalog covering every tricky duplicate. */
const CATALOG: FundsAsset[] = [
  asset("1", "Ethereum", "evm", "USDC", "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", 5),
  asset("1", "Ethereum", "evm", "USDT", "0xdAC17F958D2ee523a2206206994597C13D831ec7", 5),
  asset("1", "Ethereum", "evm", "ETH", NATIVE, 5),
  asset("1", "Ethereum", "evm", "SOL", "0xD31a59c85aE9D8edEFeC411D448f90841571b89c", 5),
  asset("8453", "Base", "evm", "USDC", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"),
  asset("8453", "Base", "evm", "ETH", NATIVE),
  asset("137", "Polygon", "evm", "USDC.e", "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"),
  asset("137", "Polygon", "evm", "USDC", "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359"),
  asset("137", "Polygon", "evm", "POL", NATIVE),
  asset("10", "Optimism", "evm", "USDC", "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85"),
  asset("10", "Optimism", "evm", "USDC.e", "0x7F5c764cBc14f9669B88837ca1490cCa17c31607"),
  asset("56", "BNB Smart Chain", "evm", "USDC", "0x672147dD47674757C457eB155BAA382cc10705Dd"),
  asset("56", "BNB Smart Chain", "evm", "USDC", "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d"),
  asset("1151111081099710", "Solana", "svm", "SOL", NATIVE),
  asset("1151111081099710", "Solana", "svm", "SOL", "11111111111111111111111111111111"),
  asset("8453", "Base", "evm", "SOL", "0x311935Cd80b76d6a7a3438f545a04cca310bb46e"),
  asset(
    "1151111081099710",
    "Solana",
    "svm",
    "USDC",
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  ),
  asset("728126428", "Tron", "tvm", "USDT", "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", 7),
  asset("8253038", "Bitcoin", "btc", "BTC", NATIVE, 7),
  asset("8253038", "Bitcoin", "btc", "BTC", "bc1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq", 7),
  asset("999", "HyperEVM", "evm", "USDC", "0xb88339CB7199b77E23DB6E890353E22632Ba630f"),
];

describe("symbolGroup", () => {
  it("folds bridged .e variants into the canonical symbol", () => {
    expect(symbolGroup("USDC.e")).toBe("USDC");
    expect(symbolGroup("USDC.E")).toBe("USDC");
    expect(symbolGroup("usdc")).toBe("USDC");
    expect(symbolGroup("WETH")).toBe("WETH");
  });
});

describe("chainsForGroup", () => {
  it("lists USDC chains popularity-first with unranked chains last", () => {
    const chains = chainsForGroup(CATALOG, "USDC");
    expect(chains.map((c) => c.chainName)).toEqual([
      "Ethereum",
      "Base",
      "Polygon",
      "Optimism",
      "BNB Smart Chain",
      "Solana",
      "HyperEVM",
    ]);
  });

  it("keeps the lowest minimum across variants on the same chain", () => {
    const polygon = chainsForGroup(CATALOG, "USDC").find((c) => c.chainId === "137");
    expect(polygon?.minCheckoutUsd).toBe(2);
  });

  it("covers non-EVM-only groups", () => {
    expect(chainsForGroup(CATALOG, "BTC").map((c) => c.chainName)).toEqual(["Bitcoin"]);
    expect(chainsForGroup(CATALOG, "USDT").map((c) => c.chainName)).toEqual(["Ethereum", "Tron"]);
  });

  it("puts a token's home chain before chains with wrapped variants", () => {
    // SOL exists wrapped on Ethereum and Base, but Solana is where it's native.
    expect(chainsForGroup(CATALOG, "SOL").map((c) => c.chainName)).toEqual([
      "Solana",
      "Ethereum",
      "Base",
    ]);
  });
});

describe("assetForSelection", () => {
  it("prefers canonical USDC over USDC.e on Polygon", () => {
    const picked = assetForSelection(CATALOG, "USDC", "137");
    expect(picked?.token.symbol).toBe("USDC");
    expect(picked?.token.address).toBe("0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359");
  });

  it("prefers family-native identifiers on non-EVM chains", () => {
    expect(assetForSelection(CATALOG, "SOL", "1151111081099710")?.token.address).toBe(
      "11111111111111111111111111111111",
    );
    expect(assetForSelection(CATALOG, "BTC", "8253038")?.token.address).toBe(
      "bc1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq",
    );
  });

  it("returns null when the group is absent from the chain", () => {
    expect(assetForSelection(CATALOG, "BTC", "137")).toBeNull();
  });
});

describe("defaultChainFor", () => {
  it("uses the connected wallet's chain when it carries the token", () => {
    const chains = chainsForGroup(CATALOG, "USDC");
    expect(defaultChainFor(chains, 137)?.chainName).toBe("Polygon");
  });

  it("falls back to the most popular chain otherwise", () => {
    const chains = chainsForGroup(CATALOG, "USDC");
    expect(defaultChainFor(chains, 728126428 as unknown as number)?.chainName).toBe("Ethereum");
    expect(defaultChainFor(chains, undefined)?.chainName).toBe("Ethereum");
  });

  it("sends native-coin groups home even when connected elsewhere", () => {
    // Connected to Ethereum, clicking SOL still means native SOL on Solana —
    // not the wrapped ERC-20.
    expect(defaultChainFor(chainsForGroup(CATALOG, "SOL"), 1)?.chainName).toBe("Solana");
    expect(defaultChainFor(chainsForGroup(CATALOG, "BTC"), 137)?.chainName).toBe("Bitcoin");
    // But within the native set the connected chain wins: ETH on Base stays Base.
    const eth = [
      ...CATALOG,
      {
        id: "8453:eth",
        chainId: "8453",
        chainName: "Base",
        addressType: "evm" as const,
        minCheckoutUsd: 2,
        token: { name: "Ether", symbol: "ETH", address: NATIVE, decimals: 18 },
      },
    ];
    expect(defaultChainFor(chainsForGroup(eth, "ETH"), 8453)?.chainName).toBe("Base");
  });
});

describe("searchAssets", () => {
  it("matches symbol, name, and chain, symbol-prefix first", () => {
    const bySymbol = searchAssets(CATALOG, "usdt");
    expect(bySymbol.map((a) => a.chainName)).toEqual(["Ethereum", "Tron"]);
    const byChain = searchAssets(CATALOG, "tron");
    expect(byChain).toHaveLength(1);
    expect(byChain[0]?.token.symbol).toBe("USDT");
  });

  it("returns the whole catalog (capped) for an empty query", () => {
    expect(searchAssets(CATALOG, "").length).toBe(CATALOG.length);
    expect(searchAssets(CATALOG, "", 5).length).toBe(5);
  });
});

describe("isNativePlaceholder", () => {
  it("only matches the Bridge's native pseudo-address", () => {
    expect(isNativePlaceholder(NATIVE)).toBe(true);
    expect(isNativePlaceholder("0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174")).toBe(false);
  });
});
