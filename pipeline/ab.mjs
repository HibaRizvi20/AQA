#!/usr/bin/env node
// The A/B harness.
//
//   node pipeline/ab.mjs <spec.json> --truth <truth.json> [--models a,b] [--mode single|pipeline]
//
// Mode A  one capable agent, one wide prompt, the whole workflow alone
// Mode B  the twelve-agent pipeline with its gates
//
// Held constant: the application, the requirement, the planted defects, the
// traps, the model, the tools, and the scoring. The architecture is the only
// variable. Giving one side better tools would measure the tools.
//
// FAIRNESS NOTES, because a benchmark is only as honest as its asymmetries:
//
//   · Both sides are asked for the same things — an interpretation, classified
//     observations, defects with evidence. The single agent is not penalised for
//     a shape it was never asked to produce.
//   · Both sides' cases are re-run through the SAME runner, so neither is scored
//     on verdicts it wrote about itself.
//   · The single agent scores 0 on self-correction by construction. That is a
//     structural fact about one pass, reported as such rather than hidden.
//   · Weights were pre-registered in weights.mjs before any run.
//
// It measures ONE run of each per model. That is evidence, not proof.

import fs from "node:fs";
import path from "node:path";
import {loadConfig, ConfigError} from "./lib/config.mjs";
import {loadSpec, SpecError} from "./lib/spec.mjs";
import {createProvider, newLedger, ProviderError} from "./lib/provider.mjs";
import "./lib/providers/anthropic.mjs";
import {systemPromptFor, extractJson} from "./lib/agents.mjs";
import {buildTools} from "./lib/tools.mjs";
import {executeCases} from "./lib/executor.mjs";
import {authenticate} from "./lib/probe.mjs";
import {PHASES, ASYNC_TRACKS} from "./phases.mjs";
import {scoreRun} from "./bench/score.mjs";
import {collectPipeline, collectSingle} from "./bench/collect.mjs";
import {overall, verdict, WEIGHTS, WEIGHT_RATIONALE, COST_POLICY} from "./bench/weights.mjs";
import {openLog} from "./bench/log.mjs";

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`,
};
const nonce = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/* ── Mode A ──────────────────────────────────────────────────────────────── */

const SINGLE_SCHEMA = `{
  "interpretation": "string (what you understand the requirement to mean)",
  "ambiguities": ["string (what the requirement does not settle)"],
  "cases": [{"id": "string", "title": "string", "type": "string", "area": "string", "layer": "API|UI", "contract": {}, "ui": {"steps": []}}],
  "observations": [{
    "observable": "string (what you saw, e.g. '500 on re-adding a deleted link')",
    "classification": "product_defect|valid_behaviour|requirement_misunderstanding|test_false_alarm|inconclusive",
    "evidence": "string"
  }],
  "defects": [{
    "id": "string", "severity": "high|medium|low", "area": "string", "summary": "string",
    "observed": "string", "expected": "string", "rule": "string",
    "reproduction": "string", "why_a_defect": "string"
  }],
  "coverage_gaps": ["string"]
}`;

async function runSingle({spec, cfg, provider}) {
  const ledger = newLedger();
  const session = {token: null, nonce: nonce()};
  session.token = (await authenticate(cfg, spec.auth, {timeoutMs: cfg.REQUEST_TIMEOUT_MS})).token ?? null;

  const ctx = {spec, cfg, session, provider, ledger, repoRoot: process.cwd(), runDir: "/tmp/aqa-ab-single", artifacts: {}};
  const tools = buildTools(["probe", "ui", "tags", "files", "artifacts"], ctx);

  const prompt = [
    `## The requirement\n\`\`\`json\n${JSON.stringify(spec, null, 2)}\n\`\`\``,
    `## The application under test\nweb: ${cfg.APP_BASE_URL}\napi: ${cfg.API_BASE_URL}`,
    `## Your tools\n${tools.map((t) => `- ${t.name}: ${t.description}`).join("\n")}`,
    `## What matters\nClassify every suspicious behaviour you see. Not every failing check is a defect: the application may be right and the test wrong, or the requirement may have been misread. Reporting a correct behaviour as a defect is the most expensive mistake here.`,
    `## Answer with exactly this JSON and nothing else\n\`\`\`json\n${SINGLE_SCHEMA}\n\`\`\``,
  ].join("\n\n");

  const started = Date.now();
  const res = await provider.run({system: systemPromptFor("single-agent"), prompt, tools, maxTurns: 60});
  const ms = Date.now() - started;
  ledger.record("single-agent", res.usage, ms);

  let raw;
  try {
    raw = extractJson(res.text);
  } catch (e) {
    raw = {_parseError: String(e.message), _raw: res.text.slice(0, 4000)};
  }

  // Re-run its cases through the same runner the pipeline uses, so neither side
  // is scored on verdicts it wrote about itself.
  const execution = raw.cases?.length ? await executeCases(raw.cases, ctx) : {ran: 0, passed: 0, failed: 0, skipped: 0, results: []};

  return {mode: "single", raw, collected: {...collectSingle(raw), execution}, usage: ledger.total(), ms, stopReason: res.stopReason, toolCalls: res.toolCalls.length};
}

/* ── Mode B ──────────────────────────────────────────────────────────────── */

async function runPipeline({spec, cfg, provider, runsDir, tag}) {
  const ledger = newLedger();
  const session = {token: null, nonce: nonce()};
  const runDir = path.join(runsDir, `ab-pipeline-${tag}`);
  fs.rmSync(runDir, {recursive: true, force: true});
  fs.mkdirSync(path.join(runDir, "artifacts"), {recursive: true});

  const artifacts = {};
  const started = Date.now();
  let gates = 0;
  const phaseFailures = [];

  for (const phase of [...PHASES, ...ASYNC_TRACKS]) {
    try {
      const artifact = await phase.run({spec, cfg, artifacts, session, provider, ledger, repoRoot: process.cwd(), runDir, send: false});
      artifacts[phase.id] = artifact;
      fs.writeFileSync(path.join(runDir, "artifacts", `${phase.id}.json`), JSON.stringify(artifact, null, 2));
      if (phase.gate) gates++;
      log.line(`      ${c.ok("ok")} ${phase.id}`);
    } catch (e) {
      phaseFailures.push({phase: phase.id, error: String(e.message ?? e)});
      log.line(`      ${c.warn("!!")} ${phase.id}: ${String(e.message ?? e).slice(0, 90)}`);
    }
  }

  return {
    mode: "pipeline",
    artifacts,
    collected: collectPipeline(artifacts),
    usage: ledger.total(),
    ms: Date.now() - started,
    humanCheckpoints: gates,
    phaseFailures,
    runDir,
  };
}

/* ── one model, both architectures ───────────────────────────────────────── */

async function compareOn(model, {spec, cfg, truth, runsDir, only}) {
  const provider = createProvider(process.env.AQA_PROVIDER ?? "anthropic", {model});
  console.log(c.bold(`\n  ── ${provider.model} ──`));

  let A = null;
  let B = null;

  if (only !== "pipeline") {
    console.log(c.dim("    Mode A · single agent"));
    A = await runSingle({spec, cfg, provider});
    A.score = scoreRun({...A.collected, usage: A.usage, ms: A.ms}, truth);
    A.overall = overall(A.score.criteria);
  }
  if (only !== "single") {
    console.log(c.dim("    Mode B · twelve agents"));
    B = await runPipeline({spec, cfg, provider, runsDir, tag: model.replace(/[^\w.-]/g, "_")});
    B.score = scoreRun({...B.collected, usage: B.usage, ms: B.ms}, truth);
    B.overall = overall(B.score.criteria);
  }
  return {model: provider.model, single: A, pipeline: B};
}

/* ── the table ───────────────────────────────────────────────────────────── */

const n = (v) => (v === null || v === undefined ? "—" : typeof v === "number" ? (Number.isInteger(v) ? String(v) : v.toFixed(3)) : String(v));

function table(A, B) {
  const a = A?.score, b = B?.score;
  const cost = (r) => (r ? r.usage.input + r.usage.output : null);
  const rows = [
    ["Real defects found", a?.detection.truePositives, b?.detection.truePositives],
    ["Defects missed", a?.detection.falseNegatives, b?.detection.falseNegatives],
    ["False positives", a?.detection.falsePositives, b?.detection.falsePositives],
    ["Precision", a?.detection.precision, b?.detection.precision],
    ["Recall", a?.detection.recall, b?.detection.recall],
    ["Triage accuracy", a?.triage.accuracy, b?.triage.accuracy],
    ["Requirement interpretation", a?.interpretation.score, b?.interpretation.score],
    ["Correct self-corrections", a?.selfCorrection.correct, b?.selfCorrection.correct],
    ["Harmful self-corrections", a?.selfCorrection.harmful, b?.selfCorrection.harmful],
    ["Evidence quality", a?.evidence.score, b?.evidence.score],
    ["Cases generated", A?.collected.cases.length, B?.collected.cases.length],
    ["Cases executed", A?.collected.execution?.ran, B?.collected.execution?.ran],
    ["Human checkpoints", 0, B?.humanCheckpoints],
    ["Model calls", a?.cost.calls, b?.cost.calls],
    ["Agent invocations", a?.cost.agents, b?.cost.agents],
    ["Tokens (in+out)", cost(A), cost(B)],
    ["Model time (s)", a ? +(a.cost.modelMs / 1000).toFixed(1) : null, b ? +(b.cost.modelMs / 1000).toFixed(1) : null],
    ["Wall clock (s)", A ? +(A.ms / 1000).toFixed(1) : null, B ? +(B.ms / 1000).toFixed(1) : null],
    ["── WEIGHTED SCORE", A?.overall.score, B?.overall.score],
  ];
  const w = Math.max(...rows.map((r) => r[0].length));
  const line = (l, x, y, d) => `  ${String(l).padEnd(w)}  ${n(x).padStart(13)}  ${n(y).padStart(11)}  ${d ?? ""}`;
  const delta = (x, y) => (typeof x === "number" && typeof y === "number" ? (y - x > 0 ? c.ok(`+${(y - x).toFixed(3).replace(/\.?0+$/, "")}`) : y - x < 0 ? c.warn((y - x).toFixed(3).replace(/\.?0+$/, "")) : "=") : "");
  return [
    line("Metric", "Single agent", "12 agents", "Diff"),
    "  " + "─".repeat(w + 32),
    ...rows.map((r) => line(r[0], r[1], r[2], delta(r[1], r[2]))),
  ].join("\n");
}

/* ── entry ───────────────────────────────────────────────────────────────── */

import {log} from "./lib/log.mjs";

async function main() {
  const args = process.argv.slice(2);
  const specPath = args.find((a) => !a.startsWith("--") && a.endsWith(".json"));
  const flag = (k) => { const i = args.indexOf(k); return i === -1 ? undefined : args[i + 1]; };
  const truthPath = flag("--truth");
  const only = flag("--mode");
  const models = (flag("--models") ?? process.env.AQA_MODEL ?? "claude-sonnet-5").split(",").map((s) => s.trim()).filter(Boolean);

  if (!specPath || !truthPath) {
    console.log("\n  node pipeline/ab.mjs <spec.json> --truth <truth.json> [--models a,b] [--mode single|pipeline]\n");
    process.exitCode = 1;
    return;
  }

  const cfg = loadConfig();
  const spec = await loadSpec(specPath);
  const truth = JSON.parse(fs.readFileSync(truthPath, "utf8"));
  const runsDir = process.env.AQA_RUNS_DIR ?? "pipeline/runs";
  const logger = openLog(path.join(runsDir, "experiment-log.md"));

  console.log(c.bold(`\n  A/B · ${spec.title}`));
  console.log(c.dim(`  ${truth.defects.length} planted defect(s) · ${truth.correct_behaviours.length} trap(s) · ${(truth.requirement_probes ?? []).length} interpretation probe(s)`));
  console.log(c.dim(`  models: ${models.join(", ")}`));
  console.log(c.dim(`  weights: ${Object.entries(WEIGHTS).map(([k, v]) => `${k} ${v}`).join(" · ")}  (pre-registered)\n`));

  const results = [];
  for (const model of models) {
    const r = await compareOn(model, {spec, cfg, truth, runsDir, only});
    results.push(r);
    if (r.single && r.pipeline) {
      console.log("\n" + table(r.single, r.pipeline) + "\n");
      const v = verdict(
        {score: r.single.overall.score, cost: r.single.usage.input + r.single.usage.output},
        {score: r.pipeline.overall.score, cost: r.pipeline.usage.input + r.pipeline.usage.output},
      );
      console.log(`  ${c.bold("verdict")}: ${v.call}`);
      if (v.costRatio) console.log(c.dim(`  cost ratio ${v.costRatio}x · quality gain ${v.qualityGain >= 0 ? "+" : ""}${v.qualityGain}`));
      for (const [name, r2] of [["single agent", r.single], ["12 agents", r.pipeline]]) {
        const missed = r2.score.detection.missed;
        if (missed.length) console.log(c.warn(`  ${name} missed: ${missed.map((m) => `${m.id} (${m.severity})`).join(", ")}`));
        const fp = r2.score.detection.falsePositiveDetail.filter((f) => f.trap);
        if (fp.length) console.log(c.warn(`  ${name} fell for: ${fp.map((f) => f.trap.id).join(", ")}`));
      }
      logger.record(r, {truth: truthPath, verdict: v});
    }
  }

  const out = path.join(runsDir, "ab-result.json");
  fs.mkdirSync(path.dirname(out), {recursive: true});
  fs.writeFileSync(out, JSON.stringify({
    at: new Date().toISOString(),
    spec: specPath, truth: truthPath, models,
    weights: WEIGHTS, weightRationale: WEIGHT_RATIONALE, costPolicy: COST_POLICY,
    results,
  }, null, 2));

  console.log(c.dim(`\n  full result: ${out}`));
  console.log(c.dim(`  experiment log: ${logger.file}`));
  console.log(c.dim(`  one run of each per model. Evidence, not proof.\n`));
}

try {
  await main();
} catch (e) {
  if (e instanceof ConfigError || e instanceof SpecError || e instanceof ProviderError) {
    console.error(`\n  ${e.message}\n`);
    process.exitCode = 1;
  } else throw e;
}
