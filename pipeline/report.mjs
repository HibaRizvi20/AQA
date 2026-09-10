#!/usr/bin/env node
// Turn a real run into the data the Runs Explorer reads.
//
//   node pipeline/report.mjs                 # every run under pipeline/runs
//   node pipeline/report.mjs <runId> ...     # only these
//   node pipeline/report.mjs --out path.js   # write somewhere else
//
// Until now the dashboard shipped with illustrative data, which meant the product's own flagship
// view could not show the product's own output. This closes that loop: the board reads artifacts
// the pipeline actually wrote, and when no export exists it falls back to the bundled example and
// says so.

import fs from "node:fs";
import path from "node:path";

// Read at call time, not at import time: a module-scope capture makes this untestable and
// un-configurable by anything that imports it.
const runsDir = () => process.env.AQA_RUNS_DIR ?? "pipeline/runs";
const DEFAULT_OUT = "dashboard/data.js";

const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const payload = (v) => (v && v.schema === "aqa.artifact" ? v.data : v);

function loadRun(runId) {
  const dir = path.join(runsDir(), runId);
  const statePath = path.join(dir, "state.json");
  if (!fs.existsSync(statePath)) return null;

  const state = readJson(statePath);
  const artDir = path.join(dir, "artifacts");
  const artifacts = {};
  const envelopes = {};
  if (fs.existsSync(artDir)) {
    for (const f of fs.readdirSync(artDir).filter((f) => f.endsWith(".json"))) {
      const raw = readJson(path.join(artDir, f));
      const id = f.replace(/\.json$/, "");
      envelopes[id] = raw;
      artifacts[id] = payload(raw);
    }
  }
  return { state, artifacts, envelopes };
}

/** Which phases produced output, and which reported themselves as not-run. */
function agentState(artifacts) {
  const ran = [];
  const na = [];
  for (const [id, a] of Object.entries(artifacts)) {
    if (a?.status === "not_configured" || a?.status === "not_applicable") na.push(id);
    else ran.push(id);
  }
  return { ran, na };
}

function toTests(run) {
  const { artifacts } = run;
  const cases = artifacts["03-case-design"]?.cases ?? [];
  const results = new Map((artifacts["05-targeted-run"]?.results ?? []).map((r) => [r.id, r]));
  const objectives = new Map((artifacts["02-architecture"]?.objectives ?? []).map((o) => [o.id, o]));
  const triage = new Map((artifacts["06-self-heal"]?.triaged ?? []).map((t) => [t.id, t]));

  return cases.map((c) => {
    const r = results.get(c.id);
    const o = objectives.get(c.id);
    return {
      id: c.id,
      cycle: run.state.runId,
      title: c.title,
      type: c.type,
      layer: r?.layer ?? o?.track ?? "API",
      area: c.area,
      // A case with no result never ran; saying "not executed" is the honest word for that.
      verdict: r ? r.verdict : "not executed",
      duration: r?.durationMs != null ? `${r.durationMs}ms` : null,
      reason: r?.reason ?? null,
      failed: r?.failed ?? null,
      retried: r?.retried ?? false,
      checks: r?.checks ?? null,
      steps: r?.steps ?? null,
      triage: triage.get(c.id) ?? null,
    };
  });
}

function toCycle(run) {
  const { state, artifacts } = run;
  const { ran, na } = agentState(artifacts);
  const tr = artifacts["05-targeted-run"];
  const review = artifacts["08-review"];
  const scope = artifacts["01-scope"];

  return {
    id: state.runId,
    milestone: "MS-RUNS",
    name: artifacts["09-finalise"]?.entry?.feature ?? state.specId ?? state.runId,
    kind: state.finishedAt ? "completed run" : "in progress",
    target: artifacts["00-preflight"]?.app?.web ?? "—",
    source: state.specId ?? state.spec,
    started: (state.startedAt ?? "").replace("T", " ").slice(0, 16),
    ended: state.finishedAt ? state.finishedAt.replace("T", " ").slice(0, 16) : null,
    status: state.awaiting ? "paused" : state.finishedAt ? "complete" : "running",
    awaiting: state.awaiting ?? null,
    note:
      `${scope?.rationale ?? "run in progress"}. ` +
      (tr ? `${tr.passed} passed, ${tr.failed} failed, ${tr.skipped} skipped. ` : "") +
      (review ? `${review.blocking} blocking review finding(s).` : ""),
    stopReason: state.awaiting
      ? `This run is holding at <b>${state.awaiting}</b> for a human decision. Nothing past that gate has run.`
      : null,
    ran,
    na,
  };
}

function toFindings(run) {
  const { artifacts } = run;
  const out = [];
  for (const f of artifacts["00-preflight"]?.findings ?? []) {
    out.push({ id: f.id, t: f.detail, sev: f.severity === "blocking" ? "blocking" : "info", who: "pipeline", phase: "00-preflight" });
  }
  for (const t of artifacts["06-self-heal"]?.triaged ?? []) {
    out.push({ id: t.id, t: t.detail, sev: t.severity ?? "info", who: "pipeline", phase: "05-targeted-run", classification: t.classification });
  }
  for (const f of artifacts["a09-performance"]?.findings ?? []) {
    out.push({ id: f.id, t: f.evidence, sev: f.severity, who: "pipeline", phase: "a09-performance" });
  }
  for (const f of artifacts["a12-drift"]?.flags ?? []) {
    out.push({ id: `DRIFT-${f.anchor}`, t: `${f.anchor} — ${f.evidence}`, sev: "medium", who: "pipeline", phase: "a12-drift" });
  }
  for (const f of (artifacts["08-review"]?.findings ?? []).filter((x) => x.verdict !== "pass")) {
    out.push({ id: `REVIEW-${f.rule.slice(0, 24)}`, t: `${f.rule} — ${f.detail}`, sev: f.blocking ? "high" : "low", who: "pipeline", phase: "08-review" });
  }
  return out;
}

export function buildReport(runIds) {
  const runs = runIds.map(loadRun).filter(Boolean);
  if (runs.length === 0) return null;

  const cycles = runs.map(toCycle);
  const tests = runs.flatMap(toTests);
  const findings = Object.fromEntries(runs.map((r) => [r.state.runId, toFindings(r)]));
  const traces = Object.fromEntries(runs.map((r) => [r.state.runId, r.envelopes]));

  const window_ = runs.map((r) => r.state.startedAt).filter(Boolean).sort();
  return {
    generatedAt: new Date().toISOString(),
    milestones: [
      {
        id: "MS-RUNS",
        name: "Recorded runs",
        owner: "aqa",
        window: window_.length ? `${window_[0].slice(0, 10)} → ${window_.at(-1).slice(0, 10)}` : "—",
        status: cycles.every((c) => c.status === "complete") ? "complete" : "in progress",
        note: `${cycles.length} run(s) exported from ${runsDir()}. Every number below was produced by the pipeline, not written by hand.`,
      },
    ],
    cycles,
    tests,
    findings,
    traces,
  };
}

function main() {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf("--out");
  const out = outIdx > -1 ? args[outIdx + 1] : DEFAULT_OUT;
  const ids = args.filter((a, i) => !a.startsWith("--") && i !== outIdx + 1);

  const runIds = ids.length
    ? ids
    : fs.existsSync(runsDir())
      ? fs.readdirSync(runsDir()).filter((d) => fs.existsSync(path.join(runsDir(), d, "state.json")))
      : [];

  if (runIds.length === 0) {
    console.error(`no runs found under ${runsDir()} — run the pipeline first`);
    process.exitCode = 1;
    return;
  }

  const report = buildReport(runIds);
  if (!report) {
    console.error("nothing could be read from those runs");
    process.exitCode = 1;
    return;
  }

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `// Generated by pipeline/report.mjs — do not edit.\nwindow.AQA_DATA = ${JSON.stringify(report, null, 2)};\n`);
  console.log(`  ${runIds.length} run(s) → ${out}`);
  console.log(`  ${report.tests.length} test(s), ${Object.values(report.findings).flat().length} finding(s)`);
  console.log(`  open dashboard/index.html`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
