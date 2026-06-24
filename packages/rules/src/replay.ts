/**
 * Deterministic replay harness (docs/04 §8). Because the evaluator and state
 * machine are pure, replay is just folding the transition function over an
 * ordered event sequence. Used by tests to assert state transitions + evidence
 * on recorded fixtures, and later to show users a hypothetical trigger history.
 */
import { initialRuntime, transition } from "./state-machine.js";
import type {
  EvalEvent,
  RuleDefinition,
  RuleRuntime,
  StateTransition,
  TriggerEvidence,
} from "./types.js";

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
