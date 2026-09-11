// Anthropic provider: a real agent loop with tool use.
//
// Built on the Messages API rather than a higher-level agent runner, because the
// comparison this exists to serve needs EXACT token accounting per agent. A
// wrapper that hides the loop also hides the number, and "twelve agents cost N
// times a single agent" is half the question the architecture has to answer.
//
// The loop is the standard one: send the conversation, and while the model asks
// for tools, run them and hand the results back. Every call and every result is
// recorded, so an agent's reasoning is auditable after the fact rather than
// only its conclusion.

import {ProviderError, registerProvider} from "../provider.mjs";
import {log} from "../log.mjs";

const DEFAULT_MODEL = "claude-sonnet-5";
const MAX_TURNS = 24;

async function loadSdk() {
  try {
    const mod = await import("@anthropic-ai/sdk");
    return mod.default ?? mod.Anthropic;
  } catch {
    throw new ProviderError(
      "the Anthropic SDK is not installed — run `npm install @anthropic-ai/sdk` to let AQA drive its own agents",
    );
  }
}

function toolParam(t) {
  return {name: t.name, description: t.description, input_schema: t.input_schema};
}

/** Render a tool result for the model. Errors are reported, never thrown away. */
function resultBlock(id, value) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null, null, 2);
  return {type: "tool_result", tool_use_id: id, content: text.slice(0, 60_000)};
}

registerProvider("anthropic", (opts = {}) => {
  const model = opts.model ?? process.env.AQA_MODEL ?? DEFAULT_MODEL;
  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
  const maxTokens = opts.maxTokens ?? 8192;

  let client;
  const getClient = async () => {
    if (client) return client;
    if (!apiKey) {
      throw new ProviderError(
        "ANTHROPIC_API_KEY is not set — AQA drives its own agents and needs a key to do so",
      );
    }
    const Anthropic = await loadSdk();
    client = new Anthropic({apiKey});
    return client;
  };

  return {
    id: "anthropic",
    model,

    async run({system, prompt, tools = [], maxTurns = MAX_TURNS}) {
      const api = await getClient();
      const byName = new Map(tools.map((t) => [t.name, t]));
      const messages = [{role: "user", content: prompt}];
      const toolCalls = [];
      const usage = {input: 0, output: 0, calls: 0};
      let stopReason = "end_turn";

      for (let turn = 0; turn < maxTurns; turn++) {
        let res;
        try {
          res = await api.messages.create({
            model,
            max_tokens: maxTokens,
            system,
            messages,
            ...(tools.length ? {tools: tools.map(toolParam)} : {}),
          });
        } catch (e) {
          const status = e?.status ?? null;
          // 429 and 5xx are worth another attempt; the orchestrator's retry
          // policy decides whether to take it.
          throw new ProviderError(`model call failed: ${e?.message ?? e}`, {
            status,
            retryable: status === 429 || (status >= 500 && status < 600),
          });
        }

        usage.input += res.usage?.input_tokens ?? 0;
        usage.output += res.usage?.output_tokens ?? 0;
        usage.calls += 1;
        stopReason = res.stop_reason ?? stopReason;

        messages.push({role: "assistant", content: res.content});

        const uses = res.content.filter((b) => b.type === "tool_use");
        if (uses.length === 0) {
          const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
          return {text, toolCalls, usage, stopReason};
        }

        const results = [];
        for (const use of uses) {
          const tool = byName.get(use.name);
          const started = Date.now();
          let value;
          let ok = true;
          if (!tool) {
            ok = false;
            value = {error: `no such tool: ${use.name}`};
          } else {
            try {
              value = await tool.run(use.input ?? {});
            } catch (e) {
              // A failing tool is information the agent should see and reason
              // about, not an exception that kills the phase.
              ok = false;
              value = {error: String(e?.message ?? e)};
            }
          }
          toolCalls.push({tool: use.name, args: use.input, ok, result: value, ms: Date.now() - started});
          log.debug(`tool ${use.name}`, {ok, ms: Date.now() - started});
          results.push(resultBlock(use.id, value));
        }
        messages.push({role: "user", content: results});
      }

      return {
        text: "",
        toolCalls,
        usage,
        stopReason: "max_turns",
      };
    },
  };
});
