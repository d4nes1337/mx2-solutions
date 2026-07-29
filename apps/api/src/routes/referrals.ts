import type { FastifyInstance } from "fastify";
import type { AppConfig } from "@mx2/config";
import type {
  LeaderboardRow,
  ReferralStore,
  SessionStore,
  ReferralCodeRow,
  VolumeStore,
} from "@mx2/db";
import { makeRequireAuth } from "../middleware/require-auth.js";
import { makeRateLimit } from "../middleware/rate-limit.js";
import type {} from "../auth/types.js";

export interface ReferralsRoutesDeps {
  config: AppConfig;
  sessions: SessionStore;
  referrals: ReferralStore;
  /** Volume rollups (Slice C); without it, volume fields read 0. */
  volume?: VolumeStore;
}

const codeStatus = (row: ReferralCodeRow): "active" | "disabled" | "expired" | "exhausted" => {
  if (row.disabledAt !== null) return "disabled";
  if (row.expiresAt !== null && row.expiresAt <= new Date()) return "expired";
  if (row.usedCount >= row.maxUses) return "exhausted";
  return "active";
};

export const serializeOwnedCode = (row: ReferralCodeRow) => ({
  id: row.id,
  code: row.code,
  status: codeStatus(row),
  usedCount: row.usedCount,
  maxUses: row.maxUses,
  createdAt: row.createdAt.toISOString(),
});

/** The signed-in user's referral surface: their codes and who joined through them. */
export const registerReferralsRoutes = (app: FastifyInstance, deps: ReferralsRoutesDeps): void => {
  const requireAuth = makeRequireAuth({ sessions: deps.sessions });

  app.get("/api/referrals/me", { preHandler: requireAuth }, async (req) => {
    const wallet = req.user!.walletAddress;

    // Lazy-create for sessions that predate the feature: the profile page is
    // the other place (besides login) a user first meets their code.
    await deps.referrals.ensurePersonalCode(wallet, deps.config.referrals.defaultMaxUses);
    const codes = await deps.referrals.codesForOwner(wallet);

    const redemptionsByCode = await Promise.all(
      codes.map(async (code) => ({
        codeId: code.id,
        redemptions: (await deps.referrals.redemptionsForCode(code.id)).map((r) => ({
          walletAddress: r.walletAddress,
          redeemedAt: r.redeemedAt.toISOString(),
        })),
      })),
    );

    const referredBy = await deps.referrals.redemptionForWallet(wallet);
    const attributed = deps.volume
      ? await deps.volume.attributedForCodes(codes.map((c) => c.id))
      : [];

    return {
      codes: codes.map((code) => ({
        ...serializeOwnedCode(code),
        redemptions: redemptionsByCode.find((r) => r.codeId === code.id)?.redemptions ?? [],
        attributedVolumeUsd:
          attributed.find((a) => a.codeId === code.id)?.attributedVolumeUsd ?? "0",
      })),
      /** Base for share links; the client renders `${shareBaseUrl}/r/${code}`. */
      shareBaseUrl: deps.config.baseUrl,
      referredBy: referredBy ? { redeemedAt: referredBy.redeemedAt.toISOString() } : null,
    };
  });

  // ── Public leaderboard ──────────────────────────────────────────────────────
  // No auth: this is the "show the stats publicly" surface. Wallet owners are
  // shown shortened client-side; codes are already public handles. Cached in
  // memory (single-process API, D-001) and rate-limited as an abuse brake.
  if (deps.volume) {
    const volume = deps.volume;
    const leaderboardRateLimit = makeRateLimit({
      limit: 30,
      windowMs: 60_000,
      scope: "leaderboard",
    });
    const CACHE_TTL_MS = 5 * 60_000;
    let cache: { at: number; entries: LeaderboardRow[] } | null = null;

    app.get("/api/referrals/leaderboard", { preHandler: [leaderboardRateLimit] }, async () => {
      if (!cache || Date.now() - cache.at > CACHE_TTL_MS) {
        cache = { at: Date.now(), entries: await volume.referralLeaderboard(50) };
      }
      return {
        entries: cache.entries.map((e, i) => ({
          rank: i + 1,
          code: e.code,
          ownerWallet: e.ownerWallet,
          refereeCount: e.refereeCount,
          attributedVolumeUsd: e.attributedVolumeUsd,
        })),
        updatedAt: new Date(cache.at).toISOString(),
      };
    });
  }
};
