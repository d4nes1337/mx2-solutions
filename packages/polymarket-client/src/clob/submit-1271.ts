import { getAddress } from "viem";
import { ok, err, type Result } from "@mx2/core";
import { parseError, type PolymarketError } from "../errors.js";
import type { AuthenticatedClobClient } from "./trading-client.js";
import type { L2Credentials, SignedClobOrder, SubmitOrderResponse } from "./schema.js";
import {
  build1271SignedOrder,
  type ClobV2OrderParams,
  type SignTypedDataFn,
} from "./clob-v2-session.js";

/**
 * The shared W4 order path: build + POLY_1271-sign (offline, SDK OrderBuilder)
 * and submit through the app's existing REST client. Used by both the manual
 * order route (apps/api) and the auto-executor / live quoter (apps/worker) so
 * every server-side order takes the identical, contract-tested path.
 *
 * Identity split per INTEGRATION §12a: the ORDER is maker = signer = funder =
 * deposit wallet (sigType 3, ERC-7739 envelope); the L2 request headers
 * (POLY_ADDRESS) are the EOA signer — the API-key identity.
 */
export interface Submit1271OrderInput {
  /** Embedded EOA that signs (and owns the L2 creds). */
  signerAddress: string;
  depositWalletAddress: string;
  /** Typed-data signing capability (Privy bridge). Throws on failure. */
  sign: SignTypedDataFn;
  params: ClobV2OrderParams;
  creds: L2Credentials;
  idempotencyKey: string;
}

export const submit1271Order = async (
  client: AuthenticatedClobClient,
  input: Submit1271OrderInput,
): Promise<Result<{ order: SignedClobOrder; ack: SubmitOrderResponse }, PolymarketError>> => {
  let order: SignedClobOrder;
  try {
    order = (await build1271SignedOrder(
      {
        signerAddress: input.signerAddress,
        sign: input.sign,
        depositWalletAddress: input.depositWalletAddress,
      },
      input.params,
    )) as unknown as SignedClobOrder;
  } catch (e) {
    return err(parseError(e instanceof Error ? e.message : String(e), e));
  }
  const res = await client.submitOrder(
    order,
    input.params.orderType,
    input.creds,
    getAddress(input.signerAddress),
    input.idempotencyKey,
    { postOnly: input.params.postOnly ?? false },
  );
  if (!res.ok) return err(res.error);
  return ok({ order, ack: res.value });
};
