// Loading the agents.
//
// The twelve definitions in agents/ are the product, not documentation. Each
// one's body becomes a system prompt verbatim, including its "You do NOT"
// clauses. Nothing here paraphrases them: if a boundary is wrong, it is wrong
// in the file a person can read and edit, not buried in code.
//
// Two things back the prompt up, because an instruction alone is a request:
//
//   capability — a phase is handed only the tools its remit needs, so the
//   Reviewer has no way to write a file whatever it decides it wants to do
//
//   structure  — phases are separate invocations with separate artifacts and a
//   human gate between several of them, so one agent cannot quietly become the
//   next one

import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const AGENTS_DIR = path.resolve(here, "..", "..", "agents");

/** Split YAML-ish frontmatter from the body. Only name and description are used. */
export function parseAgentFile(text) {
  const m = String(text).match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!m) return {meta: {}, body: String(text).trim()};
  const meta = {};
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i === -1) continue;
    meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return {meta, body: m[2].trim()};
}

const cache = new Map();

export function loadAgent(name, {dir = AGENTS_DIR} = {}) {
  if (cache.has(name)) return cache.get(name);
  const file = path.join(dir, `${name}.md`);
  if (!fs.existsSync(file)) {
    throw new Error(`no agent definition at ${file} — the agents/ directory is the source of truth for behaviour`);
  }
  const {meta, body} = parseAgentFile(fs.readFileSync(file, "utf8"));
  const agent = {name, description: meta.description ?? "", system: body, file};
  cache.set(name, agent);
  return agent;
}

export function listAgents({dir = AGENTS_DIR} = {}) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.replace(/\.md$/, ""));
}

// House rules every agent runs under. Deliberately short: the agent's own file
// says what it does, and this says how it must answer so the pipeline can carry
// its output to the next one.
export const HOUSE_RULES = `
You are running inside AQA, an agent-orchestrated QA pipeline. Rules that apply to every agent:

1. USE YOUR TOOLS TO FIND OUT. The running application is the source of truth, not the
   specification and not your expectations. Where a tool can check something, check it.
   Never report a selector, a route, an endpoint or a status you have not observed.

2. NEVER CLAIM A RESULT YOU DID NOT EARN. If you could not verify something, say so and say
   why. "skipped, because no browser driver is configured" is a good answer. Reporting it as
   passing is the one thing this framework exists to prevent.

3. STAY INSIDE YOUR REMIT. Your definition says what you do NOT do. Those boundaries are the
   design: another agent owns that work, and a human reviews the hand-off between you.

4. ANSWER WITH ONE JSON OBJECT and nothing else. No prose before or after, no code fences.
   The schema you must produce is given at the end of your input. Put your reasoning in the
   fields provided for it, not around the JSON.
`.trim();

/** The full system prompt for one agent: its own definition, then the house rules. */
export function systemPromptFor(agentName) {
  const agent = loadAgent(agentName);
  return `${agent.system}\n\n---\n\n${HOUSE_RULES}`;
}

/**
 * Pull the JSON object out of a model's reply.
 *
 * Models sometimes wrap JSON in a fence or add a sentence despite being asked
 * not to. Recovering from that is cheaper than failing a phase, but a reply
 * with no JSON at all is a real failure and is reported as one.
 */
export function extractJson(text) {
  const raw = String(text ?? "").trim();
  if (!raw) throw new Error("the agent returned nothing");

  const fenced = raw.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  const candidate = fenced ? fenced[1] : raw;

  try {
    return JSON.parse(candidate);
  } catch {
    /* fall through to a bracket scan */
  }

  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch {
      /* fall through */
    }
  }
  throw new Error(`the agent's reply was not JSON: ${raw.slice(0, 200)}`);
}
