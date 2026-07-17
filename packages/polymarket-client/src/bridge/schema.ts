import { z } from "zod";

export const BridgeTokenSchema = z.object({
  name: z.string(),
  symbol: z.string(),
  address: z.string(),
  decimals: z.number().int().nonnegative(),
});

export const BridgeSupportedAssetSchema = z.object({
  // The Bridge API currently returns this as a string. Keep it as string in the
  // raw client and normalize at the API boundary where product DTOs are shaped.
  chainId: z.string(),
  chainName: z.string(),
  token: BridgeTokenSchema,
  minCheckoutUsd: z.number().nonnegative(),
});

export const BridgeSupportedAssetsResponseSchema = z.object({
  supportedAssets: z.array(BridgeSupportedAssetSchema),
  note: z.string().optional(),
});

export const BridgeAddressTypeSchema = z.enum(["evm", "svm", "btc", "tvm"]);

export const BridgeDepositAddressesSchema = z
  .object({
    evm: z.string().optional(),
    svm: z.string().optional(),
    btc: z.string().optional(),
    tvm: z.string().optional(),
  })
  .catchall(z.string());

export const BridgeDepositResponseSchema = z.object({
  // Docs describe an address map keyed by wallet family. Keep passthrough so a
  // provider-added family does not break staging reads.
  addresses: BridgeDepositAddressesSchema.optional(),
  depositAddresses: BridgeDepositAddressesSchema.optional(),
});

export type BridgeSupportedAsset = z.infer<typeof BridgeSupportedAssetSchema>;
export type BridgeSupportedAssetsResponse = z.infer<typeof BridgeSupportedAssetsResponseSchema>;
export type BridgeAddressType = z.infer<typeof BridgeAddressTypeSchema>;
export type BridgeDepositAddresses = z.infer<typeof BridgeDepositAddressesSchema>;
export type BridgeDepositResponse = z.infer<typeof BridgeDepositResponseSchema>;
