/**
 * Sync guarantees for the canonical template specs: every definition a spec
 * builds must pass the arm-time validator (bound AND unbound), and few-shot
 * JSON must be valid JSON with the create_strategy top-level shape. (The API
 * additionally parses each few-shot under its zod tool mirror in ai.test.ts.)
 */
import { describe, expect, it } from "vitest";
import { TEMPLATE_SPECS, templateSpecById } from "./templates.js";
import { validateStrategyDefinition } from "./validate-v2.js";
import type { MarketRef } from "./types-v2.js";

const BOUND: MarketRef = { conditionId: "cond-1", tokenId: "tok-1", outcome: "Yes" };

describe("TEMPLATE_SPECS", () => {
  it("exposes the round-4 business scenarios", () => {
    expect(TEMPLATE_SPECS.map((t) => t.id)).toEqual([
      "re-entry",
      "spike-reversal",
      "maker-reward",
      "rebate-farm",
      "cross-market",
    ]);
  });

  for (const spec of TEMPLATE_SPECS) {
    if (spec.flag === null) {
      it(`${spec.id}: buildDefinition validates clean (bound + unbound)`, () => {
        expect(validateStrategyDefinition(spec.buildDefinition(BOUND))).toEqual([]);
        expect(validateStrategyDefinition(spec.buildDefinition())).toEqual([]);
      });
    } else {
      it(`${spec.id}: flagged spec needs cockpit binding — params are its ONLY gap`, () => {
        // A single MarketRef can't carry a YES+NO token pair, so the spec's
        // skeleton is invalid exactly on the loop params and nothing else.
        const codes = validateStrategyDefinition(spec.buildDefinition(BOUND)).map((i) => i.code);
        expect(codes).toEqual(["QUOTE_LOOP_PARAMS_INVALID"]);
      });
    }

    it(`${spec.id}: definitions are independent instances`, () => {
      const a = spec.buildDefinition(BOUND);
      const b = spec.buildDefinition(BOUND);
      expect(a).toEqual(b);
      expect(a).not.toBe(b);
      expect(a.expr).not.toBe(b.expr);
    });

    if (spec.aiFewShot) {
      it(`${spec.id}: aiFewShot JSON parses with the create_strategy shape`, () => {
        const parsed = JSON.parse(spec.aiFewShot!.json) as Record<string, unknown>;
        for (const key of [
          "name",
          "summary",
          "rootOp",
          "conditions",
          "holdsForMs",
          "action",
          "recurrence",
        ]) {
          expect(parsed, `${spec.id} few-shot missing ${key}`).toHaveProperty(key);
        }
      });
    }
  }

  it("templateSpecById resolves and misses safely", () => {
    expect(templateSpecById("re-entry")?.name).toBe("Dip buy");
    expect(templateSpecById("nope")).toBeNull();
  });
});
