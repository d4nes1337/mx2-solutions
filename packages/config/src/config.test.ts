import { describe, it, expect } from "vitest";
import { loadConfig, ConfigError } from "./index.js";

const base: NodeJS.ProcessEnv = {
  DATABASE_URL: "postgresql://u:p@localhost:5432/db",
};

describe("loadConfig", () => {
  it("applies safe defaults with all risk features off", () => {
    const cfg = loadConfig(base);
    expect(cfg.env).toBe("development");
    expect(cfg.features.liveTrading).toBe(false);
    expect(cfg.features.conditionalLiveExecution).toBe(false);
    expect(cfg.features.relayer).toBe(false);
    expect(cfg.features.bridgeFunding).toBe(false);
    expect(cfg.features.bridgeWithdrawals).toBe(false);
    expect(cfg.polymarket.clobBaseUrl).toContain("clob.polymarket.com");
    expect(cfg.polymarket.bridgeBaseUrl).toBe("https://bridge.polymarket.com");
  });

  it("parses boolean flags from strings", () => {
    const cfg = loadConfig({ ...base, FEATURE_LIVE_TRADING: "true" });
    expect(cfg.features.liveTrading).toBe(true);
  });

  it("fails closed if unattended conditional execution lacks its prerequisites", () => {
    // Enabling auto-execution without server-side signing + live trading must throw.
    expect(() => loadConfig({ ...base, FEATURE_CONDITIONAL_LIVE_EXECUTION: "true" })).toThrow(
      ConfigError,
    );
  });

  it("allows unattended execution only when fully gated", () => {
    const cfg = loadConfig({
      ...base,
      FEATURE_CONDITIONAL_LIVE_EXECUTION: "true",
      FEATURE_PRIVY_SIGNING: "true",
      FEATURE_LIVE_TRADING: "true",
      MOCK_SIGNER_PRIVATE_KEY: `0x${"1".repeat(64)}`,
    });
    expect(cfg.features.conditionalLiveExecution).toBe(true);
    expect(cfg.features.privySigning).toBe(true);
  });

  it("fails closed if server-side signing is enabled without a signer backend", () => {
    expect(() => loadConfig({ ...base, FEATURE_PRIVY_SIGNING: "true" })).toThrow(ConfigError);
  });

  it("fails closed if relayer is enabled without builder config", () => {
    expect(() =>
      loadConfig({
        ...base,
        FEATURE_RELAYER: "true",
        FEATURE_PRIVY_SIGNING: "true",
        MOCK_SIGNER_PRIVATE_KEY: `0x${"1".repeat(64)}`,
      }),
    ).toThrow(ConfigError);
  });

  it("accepts relayer config only when the signer and builder credentials are present", () => {
    const cfg = loadConfig({
      ...base,
      FEATURE_RELAYER: "true",
      FEATURE_PRIVY_SIGNING: "true",
      MOCK_SIGNER_PRIVATE_KEY: `0x${"1".repeat(64)}`,
      POLYGON_RPC_URL: "https://polygon.example.test",
      POLYMARKET_RELAYER_URL: "https://relayer.example.test",
      POLYMARKET_BUILDER_API_KEY: "builder-key",
      POLYMARKET_BUILDER_SECRET: "builder-secret",
      POLYMARKET_BUILDER_PASSPHRASE: "builder-passphrase",
    });
    expect(cfg.features.relayer).toBe(true);
    expect(cfg.polymarket.relayer.url).toBe("https://relayer.example.test");
  });

  it("rejects an invalid log level", () => {
    expect(() => loadConfig({ ...base, APP_LOG_LEVEL: "loud" })).toThrow(ConfigError);
  });

  it("defaults AI chat and open beta off with the default model", () => {
    const cfg = loadConfig(base);
    expect(cfg.features.aiChat).toBe(false);
    expect(cfg.features.openBeta).toBe(false);
    expect(cfg.ai.model).toBe("claude-sonnet-5");
    expect(cfg.ai.anthropicApiKey).toBeUndefined();
  });

  it("fails closed if AI chat is enabled without an Anthropic key", () => {
    expect(() => loadConfig({ ...base, FEATURE_AI_CHAT: "true" })).toThrow(ConfigError);
  });

  it("fails closed if bridge withdrawals are enabled without wallet withdrawals", () => {
    expect(() => loadConfig({ ...base, FEATURE_BRIDGE_WITHDRAWALS: "true" })).toThrow(ConfigError);
  });

  it("accepts AI chat when the key is present and honours AI_MODEL", () => {
    const cfg = loadConfig({
      ...base,
      FEATURE_AI_CHAT: "true",
      ANTHROPIC_API_KEY: "sk-ant-test",
      AI_MODEL: "claude-opus-4-8",
      FEATURE_OPEN_BETA: "true",
    });
    expect(cfg.features.aiChat).toBe(true);
    expect(cfg.features.openBeta).toBe(true);
    expect(cfg.ai.model).toBe("claude-opus-4-8");
  });
});
