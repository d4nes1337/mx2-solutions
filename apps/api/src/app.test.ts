import { describe, it, expect } from "vitest";
import { loadConfig } from "@mx2/config";
import { createLogger } from "@mx2/observability";
import { buildApp, type DbProbe } from "./app.js";

const config = loadConfig({ DATABASE_URL: "postgresql://u:p@localhost:5432/db" });
const logger = createLogger({ name: "api-test", level: "silent" });

const appWith = (db: DbProbe) => buildApp({ config, logger, db });

describe("health endpoints", () => {
  it("GET /healthz returns ok regardless of downstreams", async () => {
    const app = appWith({ ping: async () => false });
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ok", env: "development" });
    await app.close();
  });

  it("GET /readyz returns 200 when db is up", async () => {
    const app = appWith({ ping: async () => true });
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ready", checks: { db: "up" } });
    await app.close();
  });

  it("GET /readyz returns 503 when db is down", async () => {
    const app = appWith({ ping: async () => false });
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ status: "not_ready", checks: { db: "down" } });
    await app.close();
  });

  it("GET /api/feature-flags reports risk features off by default", async () => {
    const app = appWith({ ping: async () => true });
    const res = await app.inject({ method: "GET", url: "/api/feature-flags" });
    expect(res.json()).toMatchObject({
      liveTrading: false,
      conditionalLiveExecution: false,
      relayer: false,
    });
    await app.close();
  });
});
