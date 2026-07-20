import { describe, it, expect } from "vitest";
import {
  buildHoldings,
  evmTokensForChain,
  priceKeyFor,
  scanContracts,
  MULTICALL3_ADDRESS,
  type ChainScan,
} from "./funds-holdings";
import type { FundsAsset } from "./types";

const NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const USDC = "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359"; // native USDC on Polygon
const USDC_E = "0x2791bca1f2de4661ed88a30c99a7a9449aa84174"; // bridged USDC.e
const WETH = "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619";

const asset = (o: {
  chainId: string;
  symbol: string;
  address: string;
  chainName?: string;
  addressType?: FundsAsset["addressType"];
  decimals?: number;
  minCheckoutUsd?: number;
}): FundsAsset => ({
  id: `${o.chainId}:${o.address.toLowerCase()}`,
  chainId: o.chainId,
  chainName: o.chainName ?? "Polygon",
  addressType: o.addressType ?? "evm",
  minCheckoutUsd: o.minCheckoutUsd ?? 2,
  token: {
    name: o.symbol,
    symbol: o.symbol,
    address: o.address,
    decimals: o.decimals ?? 6,
  },
});

describe("evmTokensForChain", () => {
  const assets: FundsAsset[] = [
    asset({ chainId: "137", symbol: "USDC", address: USDC }),
    asset({ chainId: "137", symbol: "USDC.e", address: USDC_E }),
    asset({ chainId: "137", symbol: "POL", address: NATIVE, decimals: 18 }),
    // Duplicate address → deduped.
    asset({ chainId: "137", symbol: "USDC", address: USDC }),
    // Non-EVM → excluded.
    asset({ chainId: "1151111081099710", symbol: "USDC", address: "Sol1", addressType: "svm" }),
    // Other chain → excluded.
    asset({ chainId: "8453", symbol: "USDC", address: USDC }),
  ];

  it("keeps every EVM variant on the chain, dedupes exact addresses, native first", () => {
    const tokens = evmTokensForChain(assets, "137");
    expect(tokens).toHaveLength(3); // POL + USDC + USDC.e (dup dropped)
    expect(tokens[0]!.isNative).toBe(true); // native always first
    expect(tokens[0]!.decimals).toBe(18);
    const groups = tokens.map((t) => t.asset.token.symbol).sort();
    expect(groups).toEqual(["POL", "USDC", "USDC.e"]);
  });

  it("excludes non-EVM address types and other chains", () => {
    const tokens = evmTokensForChain(assets, "137");
    expect(tokens.every((t) => t.asset.addressType === "evm")).toBe(true);
    expect(tokens.every((t) => t.asset.chainId === "137")).toBe(true);
  });

  it("caps the scan but always retains native", () => {
    const tokens = evmTokensForChain(assets, "137", 2);
    expect(tokens).toHaveLength(2);
    expect(tokens.some((t) => t.isNative)).toBe(true);
  });
});

describe("scanContracts", () => {
  it("maps native → Multicall3 getEthBalance and ERC-20 → balanceOf, aligned", () => {
    const tokens = evmTokensForChain(
      [
        asset({ chainId: "137", symbol: "POL", address: NATIVE, decimals: 18 }),
        asset({ chainId: "137", symbol: "USDC", address: USDC }),
      ],
      "137",
    );
    const holder = "0x1111111111111111111111111111111111111111" as const;
    const contracts = scanContracts(tokens, holder, 137);
    expect(contracts).toHaveLength(2);
    // Native sorted first.
    expect(contracts[0]!.address).toBe(MULTICALL3_ADDRESS);
    expect(contracts[0]!.functionName).toBe("getEthBalance");
    expect(contracts[0]!.args).toEqual([holder]);
    expect(contracts[0]!.chainId).toBe(137);
    expect(contracts[1]!.functionName).toBe("balanceOf");
    expect(contracts[1]!.address.toLowerCase()).toBe(USDC);
    expect(contracts[1]!.chainId).toBe(137);
  });
});

describe("priceKeyFor", () => {
  it("folds wrapped variants to their base coin", () => {
    expect(priceKeyFor("WETH")).toBe("ETH");
    expect(priceKeyFor("WBTC")).toBe("BTC");
    expect(priceKeyFor("WMATIC")).toBe("POL");
    expect(priceKeyFor("POL")).toBe("POL");
    expect(priceKeyFor("USDC.e")).toBe("USDC");
  });
});

describe("buildHoldings", () => {
  const polTokens = evmTokensForChain(
    [
      asset({ chainId: "137", symbol: "POL", address: NATIVE, decimals: 18 }),
      asset({ chainId: "137", symbol: "USDC", address: USDC }),
      asset({ chainId: "137", symbol: "USDC.e", address: USDC_E }),
    ],
    "137",
  );
  // Order after sort: [POL(native), USDC, USDC.e]
  const idx = {
    pol: polTokens.findIndex((t) => t.isNative),
    usdc: polTokens.findIndex((t) => t.asset.token.symbol === "USDC"),
    usdce: polTokens.findIndex((t) => t.asset.token.symbol === "USDC.e"),
  };

  const scanWith = (bal: { pol?: bigint; usdc?: bigint; usdce?: bigint }): ChainScan => {
    const balances: (bigint | null)[] = new Array(polTokens.length).fill(0n);
    balances[idx.pol] = bal.pol ?? 0n;
    balances[idx.usdc] = bal.usdc ?? 0n;
    balances[idx.usdce] = bal.usdce ?? 0n;
    return { chainId: "137", tokens: polTokens, balances };
  };

  it("values stables 1:1, volatiles via price, drops zero balances, sorts by USD", () => {
    const holdings = buildHoldings(
      [scanWith({ pol: 10n ** 18n, usdce: 5_000000n })], // 1 POL, 5 USDC.e, 0 USDC
      { POL: 0.5 },
    );
    expect(holdings).toHaveLength(2); // zero-balance USDC dropped
    // 5 USDC.e ($5) sorts above 1 POL ($0.50).
    expect(holdings[0]!.group).toBe("USDC");
    expect(holdings[0]!.usd).toBe(5);
    expect(holdings[0]!.symbol).toBe("USDC.e"); // held variant kept…
    expect(holdings[0]!.asset.token.address.toLowerCase()).toBe(USDC_E); // …drives the free route
    expect(holdings[1]!.group).toBe("POL");
    expect(holdings[1]!.usd).toBe(0.5);
  });

  it("folds variants of one group on one chain, keeping the larger balance", () => {
    const holdings = buildHoldings([scanWith({ usdc: 3_000000n, usdce: 5_000000n })], {});
    const usdc = holdings.filter((h) => h.group === "USDC");
    expect(usdc).toHaveLength(1);
    expect(usdc[0]!.amount).toBe(5);
    expect(usdc[0]!.symbol).toBe("USDC.e");
  });

  it("leaves USD null (and sorts last) when a volatile price is unknown", () => {
    const holdings = buildHoldings(
      [
        {
          chainId: "1",
          tokens: evmTokensForChain(
            [asset({ chainId: "1", chainName: "Ethereum", symbol: "WETH", address: WETH, decimals: 18 })],
            "1",
          ),
          balances: [2n * 10n ** 18n], // 2 WETH, no price
        },
        scanWith({ usdc: 4_000000n }),
      ],
      {}, // empty price map
    );
    expect(holdings[0]!.group).toBe("USDC"); // priced holding first
    const weth = holdings.find((h) => h.group === "WETH");
    expect(weth!.usd).toBeNull();
    expect(holdings[holdings.length - 1]!.group).toBe("WETH"); // unknown price last
  });
});
