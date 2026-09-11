// The pipeline: twelve agents, five human gates.
//
// Every phase has the same shape:
//
//     load the previous artifact
//        ↓  construct the agent's context
//        ↓  invoke the specialised agent          ← the intelligence
//        ↓  the agent reasons, using its permitted tools
//        ↓  the agent returns a structured decision
//        ↓  deterministic code carries it out     ← the mechanism
//        ↓  validate, then persist
//
// Which half owns a step:
//
//   If it requires understanding a requirement, interpreting evidence, choosing
//   a strategy, diagnosing behaviour, generating tests or judging quality, it is
//   the AGENT's. It does not move into an if/else merely because it could be
//   expressed as one.
//
//   If it is an exact mechanical operation — save this JSON, run this test,
//   apply this tag, retry three times, create this file — it is CODE's, and an
//   agent is never asked to do it by hand.
//
// The sharpest case is the targeted run. The agent chooses what to run; the
// runner runs it and writes the verdict. A model never reports that a test
// passed, because it is not the thing that decides whether it did.
//
// A remit is held three ways, in increasing strength: the agent's own
// definition, the tools it is handed, and the structure of separate invocations
// with a human gate between several of them. The Reviewer is given no file tool,
// so "cannot fix its own findings" is a fact about its reach, not a request.

import {systemPromptFor, extractJson} from "./lib/agents.mjs";
import {buildTools} from "./lib/tools.mjs";
import {executeCases, measure, verifyAnchors, buildTrackerWrites, writeArtifactFile} from "./lib/executor.mjs";
import {log} from "./lib/log.mjs";

const pretty = (v) => JSON.stringify(v ?? null, null, 2);

/**
 * Ask one agent for a decision.
 *
 * The prompt is assembled identically for every agent — what it received, what
 * it must decide, the tools it holds, the shape of the answer. Keeping that
 * uniform is what makes the single-agent comparison fair: the variable under
 * test is the decomposition, not prompt craft.
 */
async function decide({agent, task, input, schema, toolsets = [], ctx}) {
  const tools = buildTools(toolsets, ctx);
  const prompt = [
    `## What you must decide\n${task}`,
    `## What you received\n\`\`\`json\n${pretty(input)}\n\`\`\``,
    tools.length
      ? `## Your tools\n${tools.map((t) => `- ${t.name}: ${t.description}`).join("\n")}\n\nThe running application is the source of truth. Use these rather than assuming, and report anything you could not verify, with the reason.`
      : `## Your tools\nNone for this step. Decide from what you were given.`,
    `## Answer with exactly this JSON and nothing else\n\`\`\`json\n${schema}\n\`\`\``,
  ].join("\n\n");

  const started = Date.now();
  const res = await ctx.provider.run({system: systemPromptFor(agent), prompt, tools});
  const ms = Date.now() - started;

  ctx.ledger?.record(agent, res.usage, ms);
  log.debug(`agent ${agent}`, {ms, calls: res.usage.calls, tools: res.toolCalls.length, stop: res.stopReason});

  if (res.stopReason === "max_turns") {
    throw new Error(`${agent} did not finish within its turn budget — it may be looping on a tool`);
  }

  const decision = extractJson(res.text);
  // How the decision was reached travels with it, so a surprising artifact can
  // be traced to the reasoning and the tool calls behind it.
  decision._agent = {
    name: agent,
    model: ctx.provider.model,
    usage: res.usage,
    ms,
    toolCalls: res.toolCalls.map((c) => ({tool: c.tool, args: c.args, ok: c.ok, ms: c.ms})),
  };
  return decision;
}

/* ── 00 · Pre-flight ─────────────────────────────────────────────────────────
   AGENT decides what to look for and what the sources mean.
   TOOLS do the looking. */
async function preflight(ctx) {
  return decide({
    ctx,
    agent: "scope-analyst",
    task:
      "Before anything is planned, establish two things. First, reconcile the written intent against every source you were given: where they disagree, SURFACE the disagreement rather than resolving it — a human decides that at CP1. Second, decide which routes and controls this feature needs, then use your tools to find out whether the running application actually has them. Report anything you could not verify, with the reason.",
    input: {spec: ctx.spec, app: {web: ctx.cfg.APP_BASE_URL, api: ctx.cfg.API_BASE_URL}},
    toolsets: ["probe", "ui"],
    schema: `{
  "app": {"web": "string", "api": "string"},
  "sources": [{"source": "string", "says": "string", "agrees": true, "conflict": "string|null"}],
  "routes": [{"route": "string", "status": "reachable|error|unreachable", "evidence": "string"}],
  "elements": [{"looked_for": "string", "found": "true|false|ambiguous", "evidence": "string"}],
  "findings": [{"id": "string", "severity": "blocking|info", "detail": "string"}],
  "notes": "string"
}`,
  });
}

/* ── 01 · Scope Analyst ──────────────────────────────────────────────────────
   Pure judgement: what does this requirement mean, what is in scope, what is
   ambiguous, what evidence supports the reading. */
async function scope(ctx) {
  return decide({
    ctx,
    agent: "scope-analyst",
    task:
      "Decide what is worth testing. Read the requirement for what it actually means, not only what it literally says. Sort every candidate behaviour into exactly ONE bucket — in_scope, deferred, or out_scope — and give the evidence behind each placement. Name what is ambiguous rather than guessing at it. Emit a 0-1 confidence with a one-line rationale: low confidence is the right answer when the app cannot be verified, and it forces the CP1 review instead of a bad plan.",
    input: {spec: ctx.spec, preflight: ctx.artifacts["00-preflight"]},
    toolsets: ["probe", "artifacts"],
    schema: `{
  "interpretation": "string (what you understand this requirement to mean)",
  "in_scope": [{"id": "string", "behaviour": "string", "area": "string", "layer": "UI|API", "evidence": "string"}],
  "deferred": [{"id": "string", "behaviour": "string", "why": "string"}],
  "out_scope": [{"id": "string", "behaviour": "string", "why": "string"}],
  "ambiguities": [{"question": "string", "why_it_matters": "string"}],
  "areas_affected": ["string"],
  "confidence": 0.0,
  "rationale": "string",
  "findings": [{"id": "string", "blocking": true, "detail": "string"}]
}`,
  });
}

/* ── 02 · Test Architect ─────────────────────────────────────────────── CP1 ─
   What needs testing, at which layer, at what risk, in what order. */
async function architecture(ctx) {
  return decide({
    ctx,
    agent: "test-architect",
    task:
      "Turn the classified scope into a test plan. For each in-scope item: one clear testable objective, the layer that should carry it (API, UI, integration or performance) and why that layer rather than another, and a deliberate positive / negative / edge split. Prioritise by risk, and say what the priority is based on. Name the risks the plan does NOT cover — an honest gap is more useful than a confident omission.",
    input: {scope: ctx.artifacts["01-scope"], preflight: ctx.artifacts["00-preflight"]},
    toolsets: ["artifacts"],
    schema: `{
  "objectives": [{"id": "string", "objective": "string", "area": "string", "layer": "API|UI|integration|performance", "layer_reason": "string", "type": "happy|negative|edge|guard|lifecycle", "priority": "high|medium|low", "priority_reason": "string"}],
  "split": {"happy": 0, "negative": 0, "edge": 0, "guard": 0, "lifecycle": 0},
  "pilot": "string|null",
  "risks": [{"risk": "string", "covered": false, "detail": "string"}]
}`,
  });
}

/* ── 03 · Case Designer ──────────────────────────────────────────────── CP2 ─
   Which concrete cases exist, their preconditions and expected outcomes.
   The tag engine stamps them, so tagging stays deterministic. */
async function caseDesign(ctx) {
  return decide({
    ctx,
    agent: "case-designer",
    task:
      "Write the concrete test cases. Each objective becomes a stakeholder-readable Gherkin scenario with explicit preconditions and an observable expected outcome, 3-7 meaningful steps, prefixed with its key. Cover positive, negative and boundary cases where the objective warrants them, and prioritise by risk. Ground every step in what the application actually does. When the Gherkin is written, tag it with the tag_gherkin tool rather than by hand: the engine's precedence is fixed, so the same scenario always gets the same tag, which is what makes tag-based selection trustworthy.",
    input: {architecture: ctx.artifacts["02-architecture"], area: ctx.spec.area, title: ctx.spec.title},
    toolsets: ["tags", "artifacts", "probe"],
    schema: `{
  "file": "string",
  "gherkin": "string (the full tagged feature file)",
  "features": 1,
  "scenarios": 0,
  "cases": [{"id": "string", "title": "string", "type": "string", "area": "string", "priority": "high|medium|low", "preconditions": "string|null", "steps": ["string"], "expected": "string"}],
  "untagged": [],
  "open_questions": ["string"]
}`,
  });
}

/* ── 3b · Tracker Publisher ──────────────────────────────────────────────────
   AGENT decides which cases to publish and what each record says.
   CODE builds the exact records: a model never shapes an outbound write. */
async function publish(ctx) {
  const decision = await decide({
    ctx,
    agent: "tracker-publisher",
    task:
      "Decide which of the approved cases should become tracker records, and what each record should say: summary, preconditions, steps and expected result. Do not construct HTTP calls — name the cases and their content, and the pipeline builds the exact records. Nothing is sent until a human says so.",
    input: {cases: ctx.artifacts["03-case-design"]?.cases ?? [], tracker: {configured: ctx.cfg.canPublish}},
    toolsets: ["artifacts"],
    schema: `{
  "selected": [{"id": "string", "title": "string", "area": "string", "type": "string", "preconditions": "string|null", "steps": ["string"], "expected": "string"}],
  "withheld": [{"id": "string", "why": "string"}],
  "reasoning": "string"
}`,
  });

  const writes = buildTrackerWrites(decision.selected, ctx.cfg);
  return {
    ...decision,
    dry_run: !ctx.send,
    sent: 0, // nothing leaves without a human at the gate
    testcases: writes.length,
    writes_pending: writes,
    reason: ctx.send && !ctx.cfg.canPublish ? "--send was given but no tracker is configured" : null,
  };
}

/* ── 04 · Test Generator ─────────────────────────────────────────────── CP3 ─
   How each case maps to executable behaviour, which selectors and endpoints to
   bind to, and what cannot safely be automated. */
async function generate(ctx) {
  return decide({
    ctx,
    agent: "test-generator",
    task:
      "Make the cases runnable. For each one decide how it maps to executable behaviour: an API contract (method, path, body, expected status and fields) or browser steps with stated selectors. VERIFY EVERY SELECTOR AND ENDPOINT against the running application before binding to it — that is what your tools are for. Where something is absent or cannot be addressed unambiguously, emit a dated skip naming what is missing; never guess a selector. Say plainly when a case cannot safely be automated.",
    input: {cases: ctx.artifacts["03-case-design"], preflight: ctx.artifacts["00-preflight"]},
    toolsets: ["probe", "ui", "files", "artifacts"],
    schema: `{
  "files": ["string"],
  "step_defs": 0,
  "selectors_verified": 0,
  "new_page_objects": 0,
  "runnable": [{"id": "string", "title": "string", "area": "string", "layer": "API|UI", "contract": {}, "ui": {"steps": []}, "verified": "string"}],
  "skipped": [{"id": "string", "reason": "string", "since": "YYYY-MM-DD"}]
}`,
  });
}

/* ── 05 · Targeted Run ───────────────────────────────────────────────── CP4 ─
   NO AGENT VERDICT. The Generator already decided what is runnable; the runner
   executes it and writes the verdict from a real request or a real browser
   step. A model is never the thing that says a test passed. */
async function targetedRun(ctx) {
  const gen = ctx.artifacts["04-generate"] ?? {};
  const cases = gen.runnable ?? [];
  const result = await executeCases(cases, ctx);
  return {
    ...result,
    selected_by: "04-generate",
    not_automated: gen.skipped ?? [],
    note: "verdicts produced by the runner from real execution, not by a model",
  };
}

/* ── 06 · Triage / Self-Heal ─────────────────────────────────────────────────
   AGENT diagnoses and proposes the permitted action.
   CODE re-runs the repair and decides whether it actually worked, so the agent
   cannot declare its own fix successful. */
async function selfHeal(ctx) {
  const run = ctx.artifacts["05-targeted-run"] ?? {};
  const failures = (run.results ?? []).filter((r) => r.verdict === "fail");

  if (failures.length === 0) {
    return {
      failures: 0, healed: 0, bugs_staged: 0, known_flaky_skipped: 0, needs_human: 0,
      cap_cycles: 3, triaged: [], note: "nothing failed, so there was nothing to triage",
    };
  }

  const decision = await decide({
    ctx,
    agent: "triage-self-healer",
    task:
      "Diagnose every failure. For each: is it a known-flaky intermittent, a test defect, a product bug, or does it need a human? Give the evidence behind your conclusion. Where it is a TEST defect and can be repaired safely, state the exact repaired case. You may NOT weaken an assertion to reach green: if the only way to pass is to assert less, that is a product bug or a human decision, not a heal. Where it is a product bug, stage it with evidence and do not touch the test.",
    input: {failures, generated: ctx.artifacts["04-generate"], cases: ctx.artifacts["03-case-design"]?.cases ?? []},
    toolsets: ["probe", "ui", "artifacts"],
    schema: `{
  "triaged": [{
    "id": "string",
    "classification": "known_flaky|test_defect|product_bug|needs_human",
    "severity": "high|medium|low|info",
    "evidence": "string",
    "detail": "string",
    "repaired_case": "null, or the full corrected case object carrying a contract or ui.steps",
    "weakened_assertion": false
  }]
}`,
  });

  // Every proposed repair is re-run. The agent proposes; execution decides.
  // "healed" means a real re-run passed, not that an agent said so.
  const repairs = (decision.triaged ?? []).filter((t) => t.classification === "test_defect" && t.repaired_case);
  const verify = repairs.length
    ? await executeCases(repairs.map((t) => ({...t.repaired_case, id: t.id})), ctx)
    : {results: []};
  const byId = new Map((verify.results ?? []).map((r) => [r.id, r]));

  const triaged = (decision.triaged ?? []).map((t) => {
    const check = byId.get(t.id);
    return check
      ? {...t, heal_verified: check.verdict === "pass", heal_result: check.verdict, heal_evidence: check.failed ?? null}
      : t;
  });

  return {
    failures: failures.length,
    healed: triaged.filter((t) => t.heal_verified).length,
    proposed_repairs_that_did_not_pass: triaged.filter((t) => t.heal_result && t.heal_result !== "pass").length,
    bugs_staged: triaged.filter((t) => t.classification === "product_bug").length,
    known_flaky_skipped: triaged.filter((t) => t.classification === "known_flaky").length,
    needs_human: triaged.filter((t) => t.classification === "needs_human").length,
    cap_cycles: 3,
    triaged,
    _agent: decision._agent,
    note: "a repair counts as healed only when the runner re-ran it and it passed",
  };
}

/* ── 07 · Regression ─────────────────────────────────────────────────────────
   AGENT decides what regression coverage this cycle needs.
   CODE runs it. The runner never invents QA strategy. */
async function regression(ctx) {
  const cases = ctx.artifacts["04-generate"]?.runnable ?? [];

  const decision = await decide({
    ctx,
    agent: "reviewer", // independent of whoever made the changes, deliberately
    task:
      "Decide what regression coverage this cycle needs, and say why. Given what changed and which areas it touched, select the cases to re-run to show that nothing already covered has broken. Selecting everything is a legitimate answer when the change is broad; so is a narrower selection when you can justify it. You are choosing scope only — the runner executes and writes the verdicts.",
    input: {
      available: cases.map((c) => ({id: c.id, title: c.title, area: c.area ?? null, layer: c.layer})),
      changed: ctx.artifacts["01-scope"]?.areas_affected ?? [],
      healed: ctx.artifacts["06-self-heal"]?.triaged ?? [],
    },
    toolsets: ["artifacts"],
    schema: `{"select": ["case id"], "strategy": "full|targeted", "reasoning": "string"}`,
  });

  const chosen = new Set(decision.select ?? []);
  const selected = chosen.size ? cases.filter((c) => chosen.has(c.id)) : cases;
  const result = await executeCases(selected, ctx);

  return {
    ...result,
    total: result.ran,
    strategy: decision.strategy ?? "full",
    reasoning: decision.reasoning ?? null,
    selected_by: "reviewer",
    _agent: decision._agent,
  };
}

/* ── 08 · Reviewer ───────────────────────────────────────────────────── CP5 ─
   Genuine independence. It sees the requirement, the cases, the implementation
   and the results, and may DISAGREE with earlier agents. Given no file tool: it
   reports, it does not repair. */
async function review(ctx) {
  return decide({
    ctx,
    agent: "reviewer",
    task:
      "Review this cycle as a whole and answer one question honestly: does this actually prove the feature works? Examine the requirement, the scope decisions, the cases, the generated implementation, the run results and the triage. You may disagree with earlier agents, and saying so is the reason you exist separately from them. Then review the generated tests against the conventions: every scenario keyed and tagged, no bare 2xx assertion, page objects untouched, selectors verified. Report findings; do NOT fix them — a finding silently repaired teaches nobody, and Triage owns fixes. An untagged scenario is blocking.",
    input: {
      requirement: ctx.spec,
      scope: ctx.artifacts["01-scope"],
      architecture: ctx.artifacts["02-architecture"],
      cases: ctx.artifacts["03-case-design"],
      generated: ctx.artifacts["04-generate"],
      run: ctx.artifacts["05-targeted-run"],
      triage: ctx.artifacts["06-self-heal"],
      regression: ctx.artifacts["07-regression"],
    },
    toolsets: ["artifacts", "tags", "probe"], // no files: it cannot fix what it finds
    schema: `{
  "proves_the_feature_works": true,
  "verdict_reasoning": "string",
  "disagreements": [{"with": "phase id", "what": "string", "why": "string"}],
  "findings": [{"rule": "string", "verdict": "pass|fail|warn", "blocking": false, "detail": "string"}],
  "coverage_gaps": ["string"],
  "blocking": 0,
  "passed": 0
}`,
  });
}

/* ── 09 · KB Curator ─────────────────────────────────────────────────────────
   AGENT decides what knowledge is worth keeping. CODE stores it. */
async function finalise(ctx) {
  const decision = await decide({
    ctx,
    agent: "kb-curator",
    task:
      "Decide what this cycle taught that is worth keeping. Write the Feature Registry entry: where the feature is specified, what is now true of the live app, which tests cover it, what risks were discovered, and what should become reusable QA knowledge. Stamp verified_against_live ONLY if the targeted run came back clean; otherwise leave it null and say why. A registry that claims verification it did not earn is worse than no registry.",
    input: {
      spec: ctx.spec,
      run: ctx.artifacts["05-targeted-run"],
      regression: ctx.artifacts["07-regression"],
      review: ctx.artifacts["08-review"],
      cases: ctx.artifacts["03-case-design"],
      preflight: ctx.artifacts["00-preflight"],
    },
    toolsets: ["artifacts"],
    schema: `{
  "file": "string",
  "entry": {"feature": "string", "intent": {}, "truth": {}, "ours": {}, "verified_against_live": "YYYY-MM-DD|null", "owner": "string", "coverage": "string"},
  "risks_discovered": ["string"],
  "reusable_knowledge": ["string"],
  "note": "string|null"
}`,
  }).then(async (d) => {
    if (d.file && d.entry) {
      const body = `# Feature Registry entry, written by the KB Curator.\n${JSON.stringify(d.entry, null, 2)}\n`;
      await writeArtifactFile(ctx.repoRoot, String(d.file).replace(/\.ya?ml$/, ".json"), body).catch(() => {});
    }
    return d;
  });
  return decision;
}

/* ═══ async tracks · 9-12 · report, never gate ═══════════════════════════════ */

/* AGENT interprets the timings. CODE does the timing. */
async function performance(ctx) {
  const cases = ctx.artifacts["04-generate"]?.runnable ?? [];
  const budgets = ctx.spec.budgets ?? {};
  if (Object.keys(budgets).length === 0) {
    return {
      status: "not_configured", gates: false,
      reason: "no budgets are declared in the spec, so there is nothing to measure against",
      hint: 'add "budgets": { "<case-id>": <p95 ms> }', steps: [], findings: [],
    };
  }
  const steps = await measure(cases, budgets, ctx);
  const decision = await decide({
    ctx,
    agent: "performance-analyst",
    task:
      "Here are measured timings against budgets declared before the run. Decide what they mean: where the time goes, whether anything is a real breach worth raising, and what is ordinary variance. Raise a finding ONLY on a clear breach of a declared budget, with the evidence. Never file known non-determinism as a bug. You never gate a merge.",
    input: {steps, iterations: ctx.cfg.PERF_ITERATIONS},
    toolsets: ["artifacts"],
    schema: `{"summary": "string", "findings": [{"id": "string", "severity": "string", "evidence": "string"}], "not_a_bug": ["string"]}`,
  });
  return {status: "ran", gates: false, iterations: ctx.cfg.PERF_ITERATIONS, steps, ...decision};
}

/* AGENT decides which deviations are meaningful. TOOLS drive both surfaces. */
async function designParity(ctx) {
  const proto = ctx.spec.prototype ?? ctx.cfg.PROTOTYPE_BASE_URL ?? null;
  if (!proto) {
    return {
      status: "not_configured", gates: false,
      reason: "no prototype source is connected, so there is nothing to compare the built app against",
      hint: 'set PROTOTYPE_BASE_URL, or add "prototype" to the spec',
    };
  }
  return decide({
    ctx,
    agent: "design-parity-analyst",
    task:
      "Compare the prototype against the built application across visual/layout, flow, copy and states. Decide which deviations are MEANINGFUL — not every difference is a defect, and a human triages regression versus deliberate evolution. Raise tickets for the DESIGN TEAM, never product bugs, and never block.",
    input: {prototype: proto, app: ctx.cfg.APP_BASE_URL, routes: ctx.spec.routes},
    toolsets: ["ui", "probe"],
    schema: `{"status": "ran", "gates": false, "checked": 0, "diffs": [{"route": "string", "axis": "visual|flow|copy|state", "detail": "string", "meaningful": true}], "note": "string"}`,
  });
}

/* AGENT judges answer quality. TOOLS ask and fetch the traces. */
async function aiEval(ctx) {
  const golden = ctx.spec.golden ?? null;
  if (!golden?.cases?.length) {
    return {
      status: "not_applicable", gates: false,
      reason: "this spec declares no assistant and no golden dataset, so there is nothing to score",
      hint: 'add "golden": { "endpoint": "...", "cases": [...] }',
    };
  }
  return decide({
    ctx,
    agent: "eval-analyst",
    task:
      "Score the assistant against the golden dataset. For each case: ask it, fetch the trace, then score on the judged axes (correctness, faithfulness, coherence, relevance) and the deterministic checks (expected tools present, no forbidden tools, no errored spans, latency within budget). Quality is a score against a baseline, never a pass/fail. A low score is surfaced, never auto-filed as a product bug, and you never gate a merge.",
    input: {golden, api: ctx.cfg.API_BASE_URL},
    toolsets: ["probe", "artifacts"],
    schema: `{"status": "ran", "gates": false, "cases": 0, "results": [{"ask": "string", "scores": {}, "deterministic": {}, "notes": "string"}], "regressions": ["string"], "summary": "string"}`,
  });
}

/* AGENT decides which anchors matter and what it cannot check.
   CODE re-verifies them. */
async function drift(ctx) {
  const entry = ctx.artifacts["09-finalise"]?.entry ?? null;
  if (!entry) {
    return {
      status: "not_configured", gates: false,
      reason: "no Feature Registry entry exists for this feature yet — nothing recorded means nothing to re-check",
      checks: [],
    };
  }

  const pick = await decide({
    ctx,
    agent: "drift-detector",
    task:
      "Decide which anchors from this registry entry must be re-verified against the live application, and say what you would NOT be able to check and why. Choose the anchors; the pipeline performs the checks and reports what happened.",
    input: {entry},
    toolsets: ["artifacts"],
    schema: `{"routes": ["string"], "contracts": [{"id": "string", "method": "string", "path": "string", "expect": {"status": 200}}], "unverifiable": [{"anchor": "string", "reason": "string"}]}`,
  });

  const checks = await verifyAnchors(pick, ctx);
  const drifted = checks.filter((c) => c.status === "drifted");
  const unchecked = checks.filter((c) => c.status === "not-checked");

  return {
    status: "ran", gates: false,
    checked: checks.length,
    verified: checks.filter((c) => c.status === "verified").length,
    drifted: drifted.length,
    not_checked: unchecked.length,
    checks,
    flags: drifted.map((c) => ({anchor: c.anchor, evidence: c.evidence, action: "human triage: product bug, or stale registry?"})),
    stamped: drifted.length === 0 && unchecked.length === 0,
    note: unchecked.length ? "stamped partial — what could not be checked is listed with its reason, not assumed fresh" : null,
    _agent: pick._agent,
  };
}

/** The gated pipeline, in order. `gate` must be approved AFTER the phase runs. */
export const PHASES = [
  {id: "00-preflight", agent: "pre-flight", gate: null, kind: "hybrid", run: preflight},
  {id: "01-scope", agent: "scope-analyst", n: 1, gate: null, kind: "agent", run: scope},
  {id: "02-architecture", agent: "test-architect", n: 2, gate: "CP1", kind: "agent", run: architecture},
  {id: "03-case-design", agent: "case-designer", n: 3, gate: "CP2", kind: "agent", run: caseDesign},
  {id: "3b-publish", agent: "tracker-publisher", n: 4, gate: null, kind: "hybrid", run: publish},
  {id: "04-generate", agent: "test-generator", n: 5, gate: "CP3", kind: "agent", run: generate},
  {id: "05-targeted-run", agent: "targeted-run", gate: "CP4", kind: "deterministic", run: targetedRun},
  {id: "06-self-heal", agent: "triage-self-healer", n: 6, gate: null, kind: "hybrid", run: selfHeal},
  {id: "07-regression", agent: "regression", gate: null, kind: "hybrid", run: regression},
  {id: "08-review", agent: "reviewer", n: 7, gate: "CP5", kind: "agent", run: review},
  {id: "09-finalise", agent: "kb-curator", n: 8, gate: null, kind: "hybrid", run: finalise},
];

/** The async tracks. They run after the pipeline and never gate it. */
export const ASYNC_TRACKS = [
  {id: "a09-performance", agent: "performance-analyst", n: 9, kind: "hybrid", run: performance},
  {id: "a10-design-parity", agent: "design-parity-analyst", n: 10, kind: "agent", run: designParity},
  {id: "a11-ai-eval", agent: "eval-analyst", n: 11, kind: "agent", run: aiEval},
  {id: "a12-drift", agent: "drift-detector", n: 12, kind: "hybrid", run: drift},
];

export const ALL_PHASES = [...PHASES, ...ASYNC_TRACKS];
export const phaseById = (id) => ALL_PHASES.find((p) => p.id === id);
