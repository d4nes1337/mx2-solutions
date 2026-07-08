/**
 * Deterministic replay harness (docs/04 §8). Because the evaluator and state
 * machine are pure, replay is just folding the transition function over an
 * ordered event sequence. Used by tests to assert state transitions + evidence
 * on recorded fixtures, and later to show users a hypothetical trigger history.
 */
import { initialRuntime, transition } from "./state-machine.js";
import { initialRuntimeV2, transitionV2 } from "./state-machine-v2.js";
import { hashDefinition } from "./evidence.js";
import type {
  EvalEvent,
  RuleDefinition,
  RuleRuntime,
  StateTransition,
  TriggerEvidence,
} from "./types.js";
import type {
  EvalEventV2,
  StrategyDefinition,
  StrategyRuntime,
  TriggerEvidenceV2,
} from "./types-v2.js";

export interface ReplayResult {
  readonly finalState: RuleRuntime;
  readonly transitions: readonly StateTransition[];
  readonly triggers: readonly TriggerEvidence[];
}

export const runReplay = (
  def: RuleDefinition,
  events: readonly EvalEvent[],
  initial: RuleRuntime = initialRuntime(),
): ReplayResult => {
  let runtime = initial;
  const transitions: StateTransition[] = [];
  const triggers: TriggerEvidence[] = [];
  for (const event of events) {
    const result = transition(def, runtime, event);
    runtime = result.runtime;
    if (result.transition) transitions.push(result.transition);
    if (result.trigger) triggers.push(result.trigger);
  }
  return { finalState: runtime, transitions, triggers };
};

export interface ReplayResultV2 {
  readonly finalState: StrategyRuntime;
  readonly transitions: readonly StateTransition[];
  readonly triggers: readonly TriggerEvidenceV2[];
}

/**
 * v2 replay: fold transitionV2 over an ordered event sequence. The definition
 * hash defaults to hashing `def` itself — pass the original stored definition's
 * hash when replaying a compat-normalized v1 rule.
 */
export const runReplayV2 = (
  def: StrategyDefinition,
  events: readonly EvalEventV2[],
  opts: { initial?: StrategyRuntime; definitionHash?: string } = {},
): ReplayResultV2 => {
  const definitionHash = opts.definitionHash ?? hashDefinition(def);
  let runtime = opts.initial ?? initialRuntimeV2();
  const transitions: StateTransition[] = [];
  const triggers: TriggerEvidenceV2[] = [];
  for (const event of events) {
    const result = transitionV2(def, definitionHash, runtime, event);
    runtime = result.runtime;
    if (result.transition) transitions.push(result.transition);
    if (result.trigger) triggers.push(result.trigger);
  }
  return { finalState: runtime, transitions, triggers };
};
