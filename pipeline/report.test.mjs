import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildReport } from "./report.mjs";

// Build a minimal run on disk and prove the exporter reads it faithfully. The dashboard is a
// consumer of these artifacts; if the exporter invents or drops a field, the board lies.
function fakeRun(dir, runId, { awaiting = null, finished = true } = {}) {
  const art = path.join(dir, runId, "artifacts");
  fs.mkdirSync(art, { recursive: true });
  const wrap = (phase, data) => JSON.stringify({ schema: "aqa.artifact", version: 1, phase, runId, producedAt: "2026-09-10T10:00:00.000Z", data }, null, 2);
  fs.writeFileSync(path.join(dir, runId, "state.json"), JSON.stringify({
    runId, specId: "spec:x", spec: "x.json", startedAt: "2026-09-10T10:00:00.000Z",
    ...(finished ? { finishedAt: "2026-09-10T10:05:00.000Z" } : {}), steps: {}, gates: {}, awaiting,
  }));
  fs.writeFileSync(path.join(art, "00-preflight.json"), wrap("00-preflight", { app: { web: "http://app" }, routes: [], findings: [{ id: "PRE-1", severity: "blocking", detail: "route gone" }] }));
  fs.writeFileSync(path.join(art, "01-scope.json"), wrap("01-scope", { in_scope: [{ id: "T-1" }], deferred: [], confidence: 0.9, rationale: "1 of 1 verifiable" }));
  fs.writeFileSync(path.join(art, "02-architecture.json"), wrap("02-architecture", { objectives: [{ id: "T-1", track: "API", type: "negative" }], split: {}, risks: [] }));
  fs.writeFileSync(path.join(art, "03-case-design.json"), wrap("03-case-design", { cases: [{ id: "T-1", title: "A case", type: "negative", area: "auth" }, { id: "T-2", title: "Never ran", type: "happy", area: "auth" }] }));
  fs.writeFileSync(path.join(art, "05-targeted-run.json"), wrap("05-targeted-run", { ran: 1, passed: 0, failed: 1, skipped: 0, results: [{ id: "T-1", verdict: "fail", failed: ["status: expected 400, got 500"], durationMs: 12 }] }));
  fs.writeFileSync(path.join(art, "06-self-heal.json"), wrap("06-self-heal", { failures: 1, triaged: [{ id: "T-1", classification: "product_bug", severity: "high", detail: "server error for a client mistake" }] }));
  fs.writeFileSync(path.join(art, "a10-design-parity.json"), wrap("a10-design-parity", { status: "not_configured", gates: false, reason: "no prototype" }));
  fs.writeFileSync(path.join(art, "a12-drift.json"), wrap("a12-drift", { status: "ran", checked: 2, verified: 2, drifted: 0, not_checked: 0, checks: [], flags: [] }));
}

describe("report exporter", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aqa-rep-"));
  process.env.AQA_RUNS_DIR = dir;
  fakeRun(dir, "run-a");

  test("exports one cycle per run, with real dates and status", () => {
    const r = buildReport(["run-a"]);
    assert.equal(r.cycles.length, 1);
    assert.equal(r.cycles[0].id, "run-a");
    assert.equal(r.cycles[0].status, "complete");
    assert.match(r.cycles[0].started, /2026-09-10/);
  });

  test("a case with no result is 'not executed', not silently passing", () => {
    const t = buildReport(["run-a"]).tests;
    assert.equal(t.find((x) => x.id === "T-1").verdict, "fail");
    assert.equal(t.find((x) => x.id === "T-2").verdict, "not executed");
  });

  test("carries the failure detail through, so the board can show what differed", () => {
    const t = buildReport(["run-a"]).tests.find((x) => x.id === "T-1");
    assert.match(t.failed[0], /expected 400, got 500/);
    assert.equal(t.triage.classification, "product_bug");
  });

  test("separates agents that ran from agents that reported not-run", () => {
    const c = buildReport(["run-a"]).cycles[0];
    assert.ok(c.ran.includes("05-targeted-run"));
    assert.ok(c.na.includes("a10-design-parity"), "a not-configured track must not be counted as having run");
  });

  test("collects findings from every phase that produces them", () => {
    const f = buildReport(["run-a"]).findings["run-a"];
    const ids = f.map((x) => x.id);
    assert.ok(ids.includes("PRE-1"), "pre-flight findings");
    assert.ok(ids.includes("T-1"), "triage findings");
  });

  test("a run still at a gate is reported as paused, not complete", () => {
    fakeRun(dir, "run-b", { awaiting: "CP2", finished: false });
    const c = buildReport(["run-b"]).cycles[0];
    assert.equal(c.status, "paused");
    assert.equal(c.awaiting, "CP2");
    assert.match(c.stopReason, /CP2/);
  });

  test("returns null rather than a misleading empty board when nothing is readable", () => {
    assert.equal(buildReport(["does-not-exist"]), null);
  });
});
