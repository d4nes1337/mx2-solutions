/**
 * Branded identifier types. They are plain strings at runtime but prevent
 * accidentally mixing, e.g., a market id where a wallet address is expected.
 */
declare const brand: unique symbol;
export type Branded<T, B extends string> = T & { readonly [brand]: B };

export type WalletAddress = Branded<string, "WalletAddress">;
export type EventId = Branded<string, "EventId">;
export type MarketId = Branded<string, "MarketId">;
export type ConditionId = Branded<string, "ConditionId">;
export type OutcomeTokenId = Branded<string, "OutcomeTokenId">;

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** Narrow an arbitrary string to a checksum-agnostic EVM address. */
export const toWalletAddress = (value: string): WalletAddress => {
  if (!EVM_ADDRESS.test(value)) {
    throw new Error("Invalid EVM wallet address");
  }
  return value.toLowerCase() as WalletAddress;
};

export const asMarketId = (value: string): MarketId => value as MarketId;
export const asEventId = (value: string): EventId => value as EventId;
export const asConditionId = (value: string): ConditionId => value as ConditionId;
export const asOutcomeTokenId = (value: string): OutcomeTokenId => value as OutcomeTokenId;
