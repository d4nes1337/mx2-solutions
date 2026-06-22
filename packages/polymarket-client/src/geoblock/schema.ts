import { z } from "zod";

export const GeoblockResponseSchema = z.object({
  blocked: z.boolean(),
  ip: z.string(),
  country: z.string().optional().default(""),
  region: z.string().nullable().optional().default(null),
});

export type GeoblockResponse = z.infer<typeof GeoblockResponseSchema>;

export type GeoblockStatus = "allowed" | "close_only" | "blocked";

export interface GeoblockResult {
  status: GeoblockStatus;
  country: string;
  region: string | null;
  ip: string;
}
