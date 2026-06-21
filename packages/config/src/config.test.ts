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
    expect(cfg.polymarket.clobBaseUrl).toContain("clob.polymarket.com");
  });

  it("parses boolean flags from strings", () => {
    const cfg = loadConfig({ ...base, FEATURE_LIVE_TRADING: "true" });
    expect(cfg.features.liveTrading).toBe(true);
  });

  it("fails closed if unattended conditional execution is enabled", () => {
    expect(() => loadConfig({ ...base, FEATURE_CONDITIONAL_LIVE_EXECUTION: "true" })).toThrow(
      ConfigError,
    );
  });

  it("rejects an invalid log level", () => {
    expect(() => loadConfig({ ...base, APP_LOG_LEVEL: "loud" })).toThrow(ConfigError);
  });
});
