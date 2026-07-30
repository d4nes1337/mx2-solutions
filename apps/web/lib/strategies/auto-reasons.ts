/**
 * Human copy for auto-execution skip/failure reason codes (worker
 * auto-executor + retry sweeper + CLOB submit errors). Unknown codes fall
 * back to the de-snaked raw code — never an empty banner.
 */
const AUTO_FAILURE_COPY: Record<string, string> = {
  insufficient_balance: "not enough USDC in the trading wallet",
  allowances_missing: "exchange allowances not granted yet",
  deposit_wallet_required: "trading wallet not activated",
  clob_credentials_missing: "trading credentials missing",
  live_trading_disabled: "live trading is disabled on the server",
  kill_switch: "trading is paused server-side",
  auto_disabled: "auto was disarmed for this strategy",
  delegation_missing: "no auto-trading delegation",
  delegation_expired: "the auto-trading delegation expired",
  rate_limited: "the daily auto-order cap was reached",
  limits_missing: "no spending caps configured",
  per_order_cap: "the order exceeds your per-order cap",
  daily_cap: "the order exceeds your daily cap",
  total_cap: "the order exceeds your total cap",
  retry_window_expired: "funds didn't arrive within the retry window",
  rule_inactive: "the strategy was paused or cancelled first",
  conditions_not_satisfied: "conditions no longer held at execution time",
  UPSTREAM_ERROR: "the exchange rejected the order",
};

export const autoFailureCopy = (reason: string): string =>
  AUTO_FAILURE_COPY[reason] ?? reason.replaceAll("_", " ");
