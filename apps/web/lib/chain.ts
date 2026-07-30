import type { Eip1193Provider } from "./order-sign";

// Polygon mainnet — every signing surface (sign-in, CLOB auth, orders) uses
// EIP-712 domains pinned to chainId 137. Most wallets sign typed data
// regardless of the active chain, but some (mobile wallets, strict WalletConnect
// implementations) refuse or mis-sign when the active chain differs — so the
// signing flows switch the wallet to Polygon first, best-effort.

export const POLYGON_CHAIN_ID = 137;
const POLYGON_CHAIN_ID_HEX = "0x89";

const POLYGON_ADD_CHAIN_PARAMS = {
  chainId: POLYGON_CHAIN_ID_HEX,
  chainName: "Polygon Mainnet",
  nativeCurrency: { name: "POL", symbol: "POL", decimals: 18 },
  rpcUrls: ["https://polygon-rpc.com"],
  blockExplorerUrls: ["https://polygonscan.com"],
};

export type EnsureChainResult =
  | { ok: true; switched: boolean }
  | { ok: false; reason: "rejected" | "unsupported" };

/**
 * Make sure the connected wallet is on Polygon before a signature is requested.
 *
 * Best-effort by design: a `false` result means the wallet would not (or could
 * not) switch — the caller should still ATTEMPT the signature, because the
 * EIP-712 domain carries chainId 137 explicitly and most wallets honor it.
 * Never throws.
 */
export async function ensurePolygonChain(provider: Eip1193Provider): Promise<EnsureChainResult> {
  try {
    const current = (await provider.request({ method: "eth_chainId", params: [] })) as string;
    if (Number.parseInt(current, 16) === POLYGON_CHAIN_ID) return { ok: true, switched: false };
  } catch {
    // A provider without eth_chainId can't be probed — try the switch anyway.
  }
  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: POLYGON_CHAIN_ID_HEX }],
    });
    return { ok: true, switched: true };
  } catch (e) {
    // 4902: the chain is unknown to the wallet — offer to add it, then re-switch.
    const code = (e as { code?: number } | null)?.code;
    if (code === 4902) {
      try {
        await provider.request({
          method: "wallet_addEthereumChain",
          params: [POLYGON_ADD_CHAIN_PARAMS],
        });
        return { ok: true, switched: true };
      } catch {
        return { ok: false, reason: "rejected" };
      }
    }
    return { ok: false, reason: code === 4001 ? "rejected" : "unsupported" };
  }
}
