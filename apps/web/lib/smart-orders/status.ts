/**
 * Internal state machine → user-facing Smart Order status. One mapping shared
 * by the monitor page, builder and cards; internal names never reach the UI.
 */
export interface UserStatus {
  label: string;
  tone: "neutral" | "pos" | "neg" | "warn" | "accent" | "brand";
  /** Statuses that show a pulsing live dot. */
  live: boolean;
  group:
    | "monitoring"
    | "triggered"
    | "waiting_signature"
    | "auto_executing"
    | "paused"
    | "completed"
    | "failed"
    | "ended";
}

export const userStatus = (
  status: string,
  opts: {
    actionKind?: "alert" | "order" | "stop_strategy" | "quote_loop";
    execution?: "prepare" | "auto";
  } = {},
): UserStatus => {
  switch (status) {
    case "ACTIVE_WAITING":
      return { label: "Monitoring", tone: "accent", live: true, group: "monitoring" };
    case "ACTIVE_ACCUMULATING":
      return { label: "Conditions holding…", tone: "brand", live: true, group: "monitoring" };
    case "TRIGGERED_AWAITING_USER":
      return opts.actionKind === "order" && opts.execution !== "auto"
        ? {
            label: "Waiting for your signature",
            tone: "warn",
            live: true,
            group: "waiting_signature",
          }
        : { label: "Triggered", tone: "warn", live: true, group: "triggered" };
    case "EXECUTING":
      return { label: "Auto-executing", tone: "brand", live: true, group: "auto_executing" };
    case "EXECUTED_MANUALLY":
    case "EXECUTED_AUTO":
      return { label: "Completed", tone: "pos", live: false, group: "completed" };
    case "COMPLETED":
      return { label: "Completed", tone: "pos", live: false, group: "completed" };
    case "EXECUTION_FAILED":
    case "ERROR":
      return { label: "Needs attention", tone: "neg", live: false, group: "failed" };
    case "PAUSED":
      return { label: "Paused", tone: "warn", live: false, group: "paused" };
    case "EXPIRED":
      return { label: "Expired", tone: "neutral", live: false, group: "ended" };
    case "CANCELLED":
      return { label: "Cancelled", tone: "neutral", live: false, group: "ended" };
    case "INVALIDATED":
      return { label: "Market ended", tone: "neutral", live: false, group: "ended" };
    case "DRAFT":
      return { label: "Draft", tone: "neutral", live: false, group: "paused" };
    default:
      return { label: "Unknown", tone: "neutral", live: false, group: "ended" };
  }
};

export const STATUS_GROUP_ORDER: readonly UserStatus["group"][] = [
  "failed",
  "waiting_signature",
  "triggered",
  "auto_executing",
  "monitoring",
  "paused",
  "completed",
  "ended",
];

export const GROUP_TITLES: Record<UserStatus["group"], string> = {
  monitoring: "Monitoring",
  triggered: "Triggered",
  waiting_signature: "Waiting for signature",
  auto_executing: "Auto-executing",
  paused: "Paused",
  completed: "Completed",
  failed: "Needs attention",
  ended: "Ended",
};
