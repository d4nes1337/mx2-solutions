"use client";

import { useAccount } from "wagmi";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "./api";
import { ensurePolygonChain } from "./chain";
import { signTypedData, type Eip1193Provider } from "./order-sign";
import { clearStoredRefCode, getStoredRefCode } from "./referral";
import type { LoginChallenge, Me } from "./types";

async function fetchMe(): Promise<Me | null> {
  try {
    return await api.get<Me>("/api/auth/me");
  } catch (e) {
    // Not signed in is the normal unauthenticated state, not an error.
    if (e instanceof ApiError && e.status === 401) return null;
    throw e;
  }
}

export function useSession() {
  return useQuery({
    queryKey: ["me"],
    queryFn: fetchMe,
    staleTime: 30_000,
    retry: false,
  });
}

/**
 * EIP-712 sign-in. Mirrors the proven flow in docs/test-auth.html exactly:
 * fetch challenge → sign the raw typedData JSON via the wallet's EIP-1193
 * provider (eth_signTypedData_v4) → POST /verify. Signing the backend's exact
 * payload byte-for-byte avoids the domain/EIP712Domain mismatch that breaks
 * recovery.
 */
export function useSignIn() {
  const { address, connector } = useAccount();
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (opts: { inviteCode?: string } | void) => {
      if (!address || !connector) throw new Error("Connect a wallet first.");
      // The login domain is PINNED to Polygon (ADR-0002 / migration 0003) even
      // though wagmi now carries extra chains for bridge-funding sends —
      // typed-data signing works regardless of the wallet's active chain.
      const cid = 137;

      const challenge = await api.get<LoginChallenge>(
        `/api/auth/challenge?address=${address}&chainId=${cid}`,
      );

      const provider = (await connector.getProvider()) as Eip1193Provider;
      // Best-effort: strict wallets (mobile, some WalletConnect impls) refuse
      // typed data for a chain they are not on — switch to Polygon first. A
      // decline is fine; the signature attempt still proceeds.
      await ensurePolygonChain(provider);
      const signature = await signTypedData(provider, address, challenge.typedData);

      // Explicit entry wins; otherwise a code captured from a /r/CODE link
      // rides along silently. Codes are attribution only — the server never
      // refuses a login over one, so a stale stored code is harmless.
      const inviteCode = opts?.inviteCode ?? getStoredRefCode();

      return api.post<{ ok: boolean; address: string }>("/api/auth/verify", {
        address,
        nonce: challenge.nonce,
        signature,
        issuedAt: challenge.typedData.message.issuedAt,
        signedTypedData: challenge.typedData,
        // A referral code redeems atomically for the wallet that signed this
        // exact challenge (server-side binding). Optional in every sense.
        ...(inviteCode ? { inviteCode } : {}),
      });
    },
    onSuccess: () => {
      clearStoredRefCode();
      void qc.invalidateQueries({ queryKey: ["me"] });
    },
  });
}

export function useSignOut() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post("/api/auth/logout"),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["me"] });
    },
  });
}
