export interface AuthenticatedUser {
  readonly walletAddress: string;
}

declare module "fastify" {
  interface FastifyRequest {
    user: AuthenticatedUser | null;
  }
}
