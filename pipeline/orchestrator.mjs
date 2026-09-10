#!/usr/bin/env node
// AQA orchestrator — runs the phase sequence for real, writes an artifact per phase, and STOPS
// at each human gate. Resumable: approving a gate continues from where it stopped.
//
//   node pipeline/orchestrator.mjs run <spec.json>
//   node pipeline/orchestrator.mjs status <runId>
//   node pipeline/orchestrator.mjs approve <runId> CP1
//   node pipeline/orchestrator.mjs reject  <runId> CP1 --reason "scope is too wide"
//
// It calls no model. Given the same spec and the same build, it produces the same artifacts, so
// a difference between two runs is a difference in the app.

import fs from "node:fs";
import path from "node:path";
import { PHASES } from "./phases.mjs";
import { loadConfig, ConfigError } from "./lib/config.mjs";
import { loadSpec, SpecError } from "./lib/spec.mjs";

const RUNS_DIR = process.env.AQA_RUNS_DIR ?? "pipeline/runs";

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`,
  err: (s) => `\x1b[31m${s}\x1b[0m`,
};

const runDir = (id) => path.join(RUNS_DIR, id);
const statePath = (id) => path.join(runDir(id), "state.json");

function readState(id) {
  const p = statePath(id);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function writeState(st) {
  fs.mkdirSync(runDir(st.runId), { recursive: true });
  fs.writeFileSync(statePath(st.runId), JSON.stringify(st, null, 2));
}

function writeArtifact(runId, phaseId, data) {
  const dir = path.join(runDir(runId), "artifacts");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${phaseId}.json`), JSON.stringify(data ?? {}, null, 2));
}

function readArtifacts(runId) {
  const dir = path.join(runDir(runId), "artifacts");
  if (!fs.existsSync(dir)) return {};
  const out = {};
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    out[f.replace(/\.json$/, "")] = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
  }
  return out;
}

/** A one-line summary per phase, so the console says what happened without opening a file. */
function summarise(id, a) {
  switch (id) {
    case "00-preflight":
      return `${a.routes.length} route(s) probed · auth ${a.auth.obtained ? "ok" : "not obtained"} · ${a.findings.length} finding(s)`;
    case "01-scope":
      return `${a.in_scope.length} in · ${a.deferred.length} deferred · confidence ${a.confidence}`;
    case "02-architecture":
      return `${a.objectives.length} objective(s) · ${Object.entries(a.split).map(([k, v]) => `${v} ${k}`).join(", ")}`;
    case "03-case-design":
      return `${a.features} feature · ${a.scenarios} scenario(s) · ${a.untagged.length} untagged`;
    case "3b-publish":
      return `${a.testcases} payload(s) built · sent ${a.sent}${a.dry_run ? " (dry-run)" : ""}`;
    case "04-generate":
      return `${a.step_defs} runnable · ${a.skipped.length} skipped with a reason`;
    case "05-targeted-run":
      return `${a.ran} ran · ${a.passed} passed · ${a.failed} failed · ${a.skipped} skipped`;
    case "06-self-heal":
      return `${a.failures} failure(s) · ${a.bugs_staged} bug(s) staged · ${a.known_flaky_skipped} environment`;
    case "07-regression":
      return `${a.passed}/${a.total} passed`;
    case "08-review":
      return `${a.findings.length} finding(s) · ${a.blocking} blocking`;
    case "09-finalise":
      return `${a.file} · ${a.entry.coverage}`;
    default:
      return "done";
  }
}

async function cmdRun(specPath, opts) {
  const cfg = loadConfig();
  const spec = await loadSpec(specPath);
  const runId = opts.runId ?? spec.id.replace(/[^A-Za-z0-9_-]+/g, "-");

  let st = readState(runId) ?? {
    runId,
    spec: specPath,
    specId: spec.id,
    startedAt: new Date().toISOString(),
    steps: {},
    gates: {},
    awaiting: null,
  };

  console.log(c.bold(`\nAQA · ${spec.title}`));
  console.log(c.dim(`  run ${runId} · spec ${spec.id} · ${spec.behaviours.length} behaviour(s)`));
  console.log(c.dim(`  app ${cfg.APP_BASE_URL} · api ${cfg.API_BASE_URL}\n`));
  for (const d of cfg.degraded) console.log(c.warn(`  degraded: ${d}`));

  const artifacts = readArtifacts(runId);
  // Credentials live for the length of this process only. Artifacts are re-read from disk on a
  // resume, so a token stored in one would either be persisted (wrong) or lost (silently skipping
  // every authenticated probe). It travels here instead.
  // A fresh nonce per invocation. Specs write "{run}" into their data so a re-run never
  // collides with what the last run left in the app.
  const session = { token: null, nonce: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}` };
  if (spec.auth && st.steps["00-preflight"]?.status === "done") {
    const { authenticate } = await import("./lib/probe.mjs");
    const a = await authenticate(cfg, spec.auth, { timeoutMs: cfg.REQUEST_TIMEOUT_MS });
    session.token = a.token ?? null;
    if (!session.token) console.log(c.warn(`  degraded: re-authentication failed on resume — ${a.reason}`));
  }

  for (const phase of PHASES) {
    if (st.steps[phase.id]?.status === "done") {
      // Re-check the gate even on a resume, so a resume can never advance past an unapproved one.
      if (phase.gate && st.gates[phase.gate]?.decision !== "approved") return haltAtGate(st, phase);
      continue;
    }

    const started = Date.now();
    let artifact;
    try {
      artifact = await phase.run({ spec, cfg, artifacts, session, send: opts.send });
    } catch (e) {
      st.steps[phase.id] = { status: "error", at: new Date().toISOString(), error: String(e.message ?? e) };
      writeState(st);
      console.error(c.err(`\n  ✖ ${phase.id} (${phase.agent}) failed: ${e.message}`));
      console.error(c.dim(`    the run is resumable — fix the cause and re-run the same command\n`));
      process.exitCode = 1;
      return;
    }

    artifacts[phase.id] = artifact;
    writeArtifact(runId, phase.id, artifact);
    st.steps[phase.id] = { status: "done", at: new Date().toISOString(), ms: Date.now() - started };
    writeState(st);
    console.log(`  ${c.ok("✔")} ${phase.id.padEnd(16)} ${c.dim(phase.agent.padEnd(20))} ${summarise(phase.id, artifact)}`);

    if (phase.gate && st.gates[phase.gate]?.decision !== "approved") return haltAtGate(st, phase);
  }

  st.awaiting = null;
  st.finishedAt = new Date().toISOString();
  writeState(st);

  const run = artifacts["05-targeted-run"];
  const review = artifacts["08-review"];
  console.log(c.bold(`\n  pipeline complete`));
  console.log(`  ${run.passed} passed · ${run.failed} failed · ${run.skipped} skipped · ${review.blocking} blocking review finding(s)`);
  console.log(c.dim(`  artifacts: ${path.join(runDir(runId), "artifacts")}\n`));
  // A run that produced failures exits non-zero so CI can act on it.
  if (run.failed > 0 || review.blocking > 0) process.exitCode = 2;
}

function haltAtGate(st, phase) {
  st.awaiting = phase.gate;
  writeState(st);
  console.log(c.warn(`\n  ⏸  GATE ${phase.gate} — review ${path.join(runDir(st.runId), "artifacts", phase.id + ".json")}`));
  console.log(c.dim(`     approve:  node pipeline/orchestrator.mjs approve ${st.runId} ${phase.gate}`));
  console.log(c.dim(`     reject:   node pipeline/orchestrator.mjs reject  ${st.runId} ${phase.gate} --reason "..."\n`));
}

function cmdStatus(runId) {
  const st = readState(runId);
  if (!st) return fail(`no run "${runId}" under ${RUNS_DIR}`);
  console.log(c.bold(`\n  run ${st.runId}`) + c.dim(` · spec ${st.specId} · started ${st.startedAt}`));
  for (const p of PHASES) {
    const s = st.steps[p.id];
    const mark = s?.status === "done" ? c.ok("✔") : s?.status === "error" ? c.err("✖") : c.dim("·");
    const gate = p.gate ? (st.gates[p.gate]?.decision === "approved" ? c.ok(` ✓${p.gate}`) : c.warn(` ⏸${p.gate}`)) : "";
    console.log(`  ${mark} ${p.id.padEnd(16)}${c.dim(p.agent.padEnd(20))}${s?.status ?? "pending"}${gate}`);
  }
  console.log(st.awaiting ? c.warn(`\n  awaiting ${st.awaiting}\n`) : c.dim("\n  no open gate\n"));
}

function cmdGate(runId, gate, decision, reason) {
  const st = readState(runId);
  if (!st) return fail(`no run "${runId}" under ${RUNS_DIR}`);
  if (!PHASES.some((p) => p.gate === gate)) return fail(`"${gate}" is not a gate. Gates: ${PHASES.filter((p) => p.gate).map((p) => p.gate).join(", ")}`);

  st.gates[gate] = { decision, at: new Date().toISOString(), ...(reason ? { reason } : {}) };
  if (st.awaiting === gate) st.awaiting = null;

  if (decision === "rejected") {
    // Send the guarded phase, and everything after it, back to pending — a rejected plan must
    // not leave downstream artifacts standing that were derived from it.
    const i = PHASES.findIndex((p) => p.gate === gate);
    for (const p of PHASES.slice(i)) delete st.steps[p.id];
    const dir = path.join(runDir(runId), "artifacts");
    for (const p of PHASES.slice(i)) fs.rmSync(path.join(dir, `${p.id}.json`), { force: true });
  }

  writeState(st);
  console.log(decision === "approved" ? c.ok(`  ✔ ${gate} approved`) : c.warn(`  ↩ ${gate} rejected — ${reason ?? "no reason given"}`));
  if (decision === "approved") console.log(c.dim(`    continue: node pipeline/orchestrator.mjs run ${st.spec}`));
}

function fail(msg) {
  console.error(c.err(`\n  ${msg}\n`));
  process.exitCode = 1;
}

const USAGE = `
  AQA — autonomous QA agents

    node pipeline/orchestrator.mjs run <spec.json> [--send]
    node pipeline/orchestrator.mjs status <runId>
    node pipeline/orchestrator.mjs approve <runId> <CP1..CP5>
    node pipeline/orchestrator.mjs reject <runId> <CP1..CP5> --reason "why"

  --send  let the Tracker Publisher actually write. Without it, every external write is a dry-run.
`;

async function main() {
  const [cmd, a1, a2] = process.argv.slice(2);
  const args = process.argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(name);
    return i === -1 ? undefined : args[i + 1];
  };

  try {
    switch (cmd) {
      case "run":
        if (!a1) return fail("run needs a spec file");
        return await cmdRun(a1, { send: args.includes("--send"), runId: flag("--run-id") });
      case "status":
        if (!a1) return fail("status needs a runId");
        return cmdStatus(a1);
      case "approve":
        if (!a1 || !a2) return fail("approve needs a runId and a gate");
        return cmdGate(a1, a2, "approved");
      case "reject":
        if (!a1 || !a2) return fail("reject needs a runId and a gate");
        return cmdGate(a1, a2, "rejected", flag("--reason"));
      default:
        console.log(USAGE);
        process.exitCode = cmd ? 1 : 0;
    }
  } catch (e) {
    if (e instanceof ConfigError || e instanceof SpecError) return fail(e.message);
    throw e;
  }
}

// Only run when invoked directly, so the module can be imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) await main();

export { readState, writeState, summarise };
