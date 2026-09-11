#!/usr/bin/env node
// The A/B harness.
//
//   node pipeline/ab.mjs <spec.json> --truth <ground-truth.json> [--model ...]
//
// Mode A  one capable agent, one wide prompt, the whole workflow alone
// Mode B  the twelve-agent pipeline with its gates
//
// Both get the SAME toolbelt, the same application, the same requirement and the
// same model. The variable under test is the intelligence architecture, not
// whether one side happens to have better tools.
//
// Scoring needs ground truth. Without it "found six issues" cannot be told apart
// from "invented six issues", and the false-positive column is the one that
// decides whether a QA tool is worth having. The demo app carries planted
// defects and, just as importantly, planted traps: correct behaviours that look
// like defects if the requirement was misread.
//
// The honest part: this measures ONE run of each on ONE application. It is
// evidence, not proof. Run it across several specs before believing the shape.

import fs from "node:fs";
import path from "node:path";
import {loadConfig, ConfigError} from "./lib/config.mjs";
import {loadSpec, SpecError} from "./lib/spec.mjs";
import {createProvider, newLedger, ProviderError} from "./lib/provider.mjs";
import "./lib/providers/anthropic.mjs";
import {systemPromptFor, extractJson} from "./lib/agents.mjs";
import {buildTools} from "./lib/tools.mjs";
import {executeCases} from "./lib/executor.mjs";
import {PHASES, ASYNC_TRACKS} from "./phases.mjs";
import {authenticate} from "./lib/probe.mjs";
import {log} from "./lib/log.mjs";

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`,
};

const nonce = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/* ── Mode A · one agent, one pass ────────────────────────────────────────── */

async function runSingleAgent({spec, cfg, provider}) {
  const ledger = newLedger();
  const session = {token: null, nonce: nonce()};
  const auth = await authenticate(cfg, spec.auth, {timeoutMs: cfg.REQUEST_TIMEOUT_MS});
  session.token = auth.token ?? null;

  const ctx = {spec, cfg, session, provider, ledger, repoRoot: process.cwd(), runDir: "/tmp/aqa-ab-single", artifacts: {}};
  // The same toolbelt the pipeline grants across its phases, handed over at once.
  const tools = buildTools(["probe", "ui", "tags", "files", "artifacts"], ctx);

  const schema = `{
  "interpretation": "string",
  "in_scope": [{"id": "string", "behaviour": "string", "area": "string"}],
  "ambiguities": ["string"],
  "cases": [{"id": "string", "title": "string", "type": "string", "area": "string", "layer": "API|UI", "contract": {}, "ui": {"steps": []}}],
  "results": [{"id": "string", "verdict": "pass|fail|skipped", "evidence": "string"}],
  "defects": [{"id": "string", "severity": "high|medium|low", "area": "string", "summary": "string", "evidence": "string"}],
  "coverage_gaps": ["string"],
  "self_review": "string"
}`;

  const prompt = [
    `## The requirement\n\`\`\`json\n${JSON.stringify(spec, null, 2)}\n\`\`\``,
    `## The application under test\nweb: ${cfg.APP_BASE_URL}\napi: ${cfg.API_BASE_URL}`,
    `## Your tools\n${tools.map((t) => `- ${t.name}: ${t.description}`).join("\n")}`,
    `## Answer with exactly this JSON and nothing else\n\`\`\`json\n${schema}\n\`\`\``,
  ].join("\n\n");

  const started = Date.now();
  const res = await provider.run({system: systemPromptFor("single-agent"), prompt, tools, maxTurns: 60});
  const ms = Date.now() - started;
  ledger.record("single-agent", res.usage, ms);

  let out;
  try {
    out = extractJson(res.text);
  } catch (e) {
    out = {_parseError: String(e.message), _raw: res.text.slice(0, 4000), defects: [], cases: [], results: []};
  }

  // The single agent reports its own verdicts. Re-run its cases through the same
  // runner the pipeline uses, so both sides are scored on executed results rather
  // than on what each one says happened.
  const verified = out.cases?.length ? await executeCases(out.cases, ctx) : {ran: 0, passed: 0, failed: 0, skipped: 0, results: []};

  return {
    mode: "single",
    artifact: out,
    verified,
    usage: ledger.total(),
    ms,
    toolCalls: res.toolCalls.length,
    humanInterventions: 0, // by construction: one pass, no gates
    stopReason: res.stopReason,
  };
}

/* ── Mode B · the twelve-agent pipeline ──────────────────────────────────── */

async function runPipeline({spec, cfg, provider, runsDir}) {
  const ledger = newLedger();
  const session = {token: null, nonce: nonce()};
  const runDir = path.join(runsDir, "ab-pipeline");
  fs.rmSync(runDir, {recursive: true, force: true});
  fs.mkdirSync(path.join(runDir, "artifacts"), {recursive: true});

  const artifacts = {};
  const ctx = () => ({spec, cfg, artifacts, session, provider, ledger, repoRoot: process.cwd(), runDir, send: false});
  const started = Date.now();
  let gatesReached = 0;
  const failures = [];

  // Gates are auto-approved here so the comparison is like for like; the count
  // is reported, because "how many times a human had to look" is one of the
  // things being measured.
  for (const phase of [...PHASES, ...ASYNC_TRACKS]) {
    try {
      const artifact = await phase.run(ctx());
      artifacts[phase.id] = artifact;
      fs.writeFileSync(path.join(runDir, "artifacts", `${phase.id}.json`), JSON.stringify(artifact, null, 2));
      if (phase.gate) gatesReached++;
      log.line(`    ${c.ok("✔")} ${phase.id}`);
    } catch (e) {
      failures.push({phase: phase.id, error: String(e.message ?? e)});
      log.line(`    ${c.warn("!")} ${phase.id}: ${String(e.message ?? e).slice(0, 100)}`);
    }
  }

  const run = artifacts["05-targeted-run"] ?? {ran: 0, passed: 0, failed: 0, skipped: 0, results: []};
  const defects = [
    ...(artifacts["06-self-heal"]?.triaged ?? [])
      .filter((t) => t.classification === "product_bug")
      .map((t) => ({id: t.id, severity: t.severity, summary: t.detail, evidence: t.evidence})),
    ...(artifacts["00-preflight"]?.findings ?? []).map((f) => ({id: f.id, severity: f.severity, summary: f.detail, evidence: f.detail})),
    ...(artifacts["a09-performance"]?.findings ?? []).map((f) => ({id: f.id, severity: f.severity, summary: f.evidence, evidence: f.evidence})),
  ];

  return {
    mode: "pipeline",
    artifacts,
    verified: run,
    defects,
    usage: ledger.total(),
    ms: Date.now() - started,
    humanInterventions: gatesReached,
    phaseFailures: failures,
  };
}

/* ── scoring against ground truth ────────────────────────────────────────── */

const norm = (s) => String(s ?? "").toLowerCase();

function matches(reported, gt) {
  const hay = norm([reported.summary, reported.evidence, reported.id, reported.area].join(" "));
  return (gt.accept_if_mentions ?? []).some((k) => hay.includes(norm(k)));
}

function score(defectsReported, truth) {
  const reported = defectsReported ?? [];
  const found = [];
  const missed = [];

  for (const gt of truth.defects) {
    const hit = reported.find((r) => matches(r, gt));
    (hit ? found : missed).push({id: gt.id, severity: gt.severity, summary: gt.summary, ...(hit ? {matched: hit.summary} : {})});
  }

  const claimed = new Set(found.map((f) => f.id));
  const falsePositives = reported.filter((r) => {
    const isReal = truth.defects.some((gt) => matches(r, gt) && claimed.has(gt.id));
    if (isReal) return false;
    // A report that matches a known-correct behaviour is a false positive with a name.
    const trap = truth.correct_behaviours.find((ok) => norm(r.summary).includes(norm(ok.summary.split(" ").slice(0, 4).join(" "))));
    return {trap};
  }).map((r) => ({summary: r.summary, severity: r.severity ?? null}));

  return {
    truePositives: found.length,
    falseNegatives: missed.length,
    falsePositives: falsePositives.length,
    found,
    missed,
    falsePositiveDetail: falsePositives,
    recall: truth.defects.length ? +(found.length / truth.defects.length).toFixed(2) : null,
    precision: reported.length ? +(found.length / reported.length).toFixed(2) : null,
  };
}

/* ── the comparison table ────────────────────────────────────────────────── */

function table(a, b) {
  const rows = [
    ["Requirements understood", a.artifact?.interpretation ? "stated" : "not stated", b.artifacts?.["01-scope"]?.interpretation ? "stated" : "not stated"],
    ["Ambiguities surfaced", (a.artifact?.ambiguities ?? []).length, (b.artifacts?.["01-scope"]?.ambiguities ?? []).length],
    ["Test cases generated", (a.artifact?.cases ?? []).length, (b.artifacts?.["03-case-design"]?.cases ?? []).length],
    ["Cases actually executed", a.verified.ran, b.verified.ran],
    ["Executed: passed", a.verified.passed, b.verified.passed],
    ["Executed: failed", a.verified.failed, b.verified.failed],
    ["Executed: skipped", a.verified.skipped, b.verified.skipped],
    ["Defects reported", (a.artifact?.defects ?? []).length, (b.defects ?? []).length],
    ["True positives", a.score.truePositives, b.score.truePositives],
    ["False negatives", a.score.falseNegatives, b.score.falseNegatives],
    ["False positives", a.score.falsePositives, b.score.falsePositives],
    ["Recall", a.score.recall ?? "—", b.score.recall ?? "—"],
    ["Precision", a.score.precision ?? "—", b.score.precision ?? "—"],
    ["Coverage gaps named", (a.artifact?.coverage_gaps ?? []).length, (b.artifacts?.["08-review"]?.coverage_gaps ?? []).length],
    ["Self-heal attempted", "n/a", b.artifacts?.["06-self-heal"]?.failures ?? 0],
    ["Self-heal verified", "n/a", b.artifacts?.["06-self-heal"]?.healed ?? 0],
    ["Regression executed", "n/a", b.artifacts?.["07-regression"]?.total ?? 0],
    ["Human checkpoints", a.humanInterventions, b.humanInterventions],
    ["Agent invocations", a.usage.agents, b.usage.agents],
    ["Input tokens", a.usage.input.toLocaleString(), b.usage.input.toLocaleString()],
    ["Output tokens", a.usage.output.toLocaleString(), b.usage.output.toLocaleString()],
    ["Model time (s)", (a.usage.ms / 1000).toFixed(1), (b.usage.ms / 1000).toFixed(1)],
    ["Wall clock (s)", (a.ms / 1000).toFixed(1), (b.ms / 1000).toFixed(1)],
    ["Phase failures", a.stopReason === "max_turns" ? "hit turn cap" : "0", (b.phaseFailures ?? []).length],
  ];
  const w = Math.max(...rows.map((r) => r[0].length));
  const line = (l, x, y) => `  ${String(l).padEnd(w)}  ${String(x).padStart(12)}  ${String(y).padStart(12)}`;
  return [line("Metric", "Single agent", "12 agents"), "  " + "─".repeat(w + 28), ...rows.map((r) => line(...r))].join("\n");
}

/* ── entry point ─────────────────────────────────────────────────────────── */

async function main() {
  const args = process.argv.slice(2);
  const specPath = args.find((a) => !a.startsWith("--"));
  const flag = (n) => { const i = args.indexOf(n); return i === -1 ? undefined : args[i + 1]; };
  const truthPath = flag("--truth");
  const only = flag("--mode");

  if (!specPath || !truthPath) {
    console.log("\n  node pipeline/ab.mjs <spec.json> --truth <ground-truth.json> [--model <id>] [--mode single|pipeline]\n");
    process.exitCode = 1;
    return;
  }

  const cfg = loadConfig();
  const spec = await loadSpec(specPath);
  const truth = JSON.parse(fs.readFileSync(truthPath, "utf8"));
  const provider = createProvider(process.env.AQA_PROVIDER ?? "anthropic", {model: flag("--model")});
  const runsDir = process.env.AQA_RUNS_DIR ?? "pipeline/runs";

  console.log(c.bold(`\n  A/B · ${spec.title}`));
  console.log(c.dim(`  model ${provider.model} · app ${cfg.APP_BASE_URL} · ${truth.defects.length} planted defect(s), ${truth.correct_behaviours.length} trap(s)\n`));

  let a = null;
  let b = null;

  if (only !== "pipeline") {
    console.log(c.bold("  Mode A · single agent"));
    a = await runSingleAgent({spec, cfg, provider});
    a.score = score(a.artifact?.defects, truth);
    console.log(c.dim(`    ${a.score.truePositives}/${truth.defects.length} found · ${a.score.falsePositives} false positive(s) · ${a.usage.input + a.usage.output} tokens\n`));
  }

  if (only !== "single") {
    console.log(c.bold("  Mode B · twelve agents"));
    b = await runPipeline({spec, cfg, provider, runsDir});
    b.score = score(b.defects, truth);
    console.log(c.dim(`\n    ${b.score.truePositives}/${truth.defects.length} found · ${b.score.falsePositives} false positive(s) · ${b.usage.input + b.usage.output} tokens\n`));
  }

  if (a && b) {
    console.log(c.bold("  Comparison\n"));
    console.log(table(a, b));
    console.log();
    for (const [name, r] of [["single agent", a], ["12 agents", b]]) {
      if (r.score.missed.length) {
        console.log(c.warn(`  ${name} missed: ${r.score.missed.map((m) => `${m.id} (${m.severity})`).join(", ")}`));
      }
    }
    const out = path.join(runsDir, "ab-result.json");
    fs.mkdirSync(path.dirname(out), {recursive: true});
    fs.writeFileSync(out, JSON.stringify({model: provider.model, truth: truthPath, single: a, pipeline: b}, null, 2));
    console.log(c.dim(`\n  full result: ${out}`));
    console.log(c.dim(`  one run of each, on one application. Evidence, not proof.\n`));
  }
}

try {
  await main();
} catch (e) {
  if (e instanceof ConfigError || e instanceof SpecError || e instanceof ProviderError) {
    console.error(`\n  ${e.message}\n`);
    process.exitCode = 1;
  } else {
    throw e;
  }
}
