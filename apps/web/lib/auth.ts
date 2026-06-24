"use client";

import { useAccount } from "wagmi";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "./api";
import type { LoginChallenge, Me } from "./types";

// EIP-1193 provider shape we need for eth_signTypedData_v4.
interface Eip1193Provider {
  request(args: { method: string; params: unknown[] }): Promise<string>;
}

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
  const { address, connector, chainId } = useAccount();
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      if (!address || !connector) throw new Error("Connect a wallet first.");
      const cid = chainId ?? 137;

      const challenge = await api.get<LoginChallenge>(
        `/api/auth/challenge?address=${address}&chainId=${cid}`,
      );

      const provider = (await connector.getProvider()) as Eip1193Provider;
      const signature = await provider.request({
        method: "eth_signTypedData_v4",
        params: [address, JSON.stringify(challenge.typedData)],
      });

      return api.post<{ ok: boolean; address: string }>("/api/auth/verify", {
        address,
        nonce: challenge.nonce,
        signature,
        issuedAt: challenge.typedData.message.issuedAt,
        signedTypedData: challenge.typedData,
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["me"] }),
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
