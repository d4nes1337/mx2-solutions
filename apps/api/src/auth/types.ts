import type { SessionScope } from "@mx2/db";

export interface AuthenticatedUser {
  readonly walletAddress: string;
}

declare module "fastify" {
  interface FastifyRequest {
    user: AuthenticatedUser | null;
    /**
     * Restriction of the CURRENT session. null/undefined = full browser
     * session. Set only by makeRequireScopedAuth on routes that explicitly
     * accept restricted (sign-link / Mini App) sessions.
     */
    authScope?: SessionScope | null;
  }
}
