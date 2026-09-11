// The LLM provider interface.
//
// Agents are the execution engine. This is the seam they run behind, and it
// exists for two reasons:
//
//   1. AQA must run on its own, not inside somebody's chat session. Given an
//      API key it drives its own agents.
//
//   2. The single-agent-versus-twelve question cannot be answered without
//      holding the model constant, and the cheaper-models question cannot be
//      answered without changing it. Both comparisons need one seam to swap.
//
// Every provider reports token usage, because "is twelve agents worth it" is
// partly a cost question and an answer without cost is not an answer.

export class ProviderError extends Error {
  constructor(message, {retryable = false, status = null} = {}) {
    super(message);
    this.name = "ProviderError";
    this.retryable = retryable;
    this.status = status;
  }
}

/**
 * @typedef {Object} Tool
 * @property {string} name
 * @property {string} description
 * @property {object} input_schema      JSON Schema for the tool's arguments
 * @property {(args: object) => Promise<unknown>} run
 */

/**
 * @typedef {Object} RunResult
 * @property {string} text              the agent's final message
 * @property {Array}  toolCalls         every call it made, in order, with results
 * @property {{input: number, output: number, calls: number}} usage
 * @property {string} stopReason
 */

/**
 * @typedef {Object} Provider
 * @property {string} id
 * @property {string} model
 * @property {(opts: {system: string, prompt: string, tools?: Tool[], maxTurns?: number}) => Promise<RunResult>} run
 */

const registry = new Map();

/** Register a provider factory under a name usable in config. */
export function registerProvider(name, factory) {
  registry.set(name, factory);
}

export function availableProviders() {
  return [...registry.keys()];
}

/**
 * Build a provider by name. Throws a message an operator can act on, rather
 * than failing later inside a phase.
 */
export function createProvider(name, opts = {}) {
  const factory = registry.get(name);
  if (!factory) {
    throw new ProviderError(
      `unknown provider "${name}" — available: ${availableProviders().join(", ") || "none registered"}`,
    );
  }
  return factory(opts);
}

/** Usage accumulator, so a whole run can be costed and compared. */
export function newLedger() {
  const entries = [];
  return {
    record(agent, usage, ms) {
      entries.push({agent, ...usage, ms});
    },
    entries: () => entries.slice(),
    total() {
      return entries.reduce(
        (a, e) => ({
          input: a.input + (e.input ?? 0),
          output: a.output + (e.output ?? 0),
          calls: a.calls + (e.calls ?? 0),
          ms: a.ms + (e.ms ?? 0),
          agents: a.agents + 1,
        }),
        {input: 0, output: 0, calls: 0, ms: 0, agents: 0},
      );
    },
  };
}
