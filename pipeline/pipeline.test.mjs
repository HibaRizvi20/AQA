// End-to-end: drive the real CLI against the real demo app and assert on the artifacts it wrote.
//
// This is the test that would have caught what the first real run did not: the pipeline used to
// mark every phase "done" without executing anything, and no test noticed because no test ran it.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const ORCH = path.join(repo, "pipeline", "orchestrator.mjs");
const SPEC = path.join(repo, "examples", "demo-spec.json");
const RUN_ID = "spec-demo-items";

let app, port, runsDir, env;

const aqa = (...args) =>
  run("node", [ORCH, ...args], { cwd: repo, env, timeout: 60000 }).catch((e) => e); // exit code is data

before(async () => {
  port = 4300 + Math.floor(Math.random() * 400);
  app = (await import("node:child_process")).spawn("node", [path.join(repo, "examples", "demo-app.mjs")], {
    env: { ...process.env, PORT: String(port) },
    stdio: "ignore",
  });
  // wait for it to answer rather than sleeping a guessed amount
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  runsDir = fs.mkdtempSync(path.join(os.tmpdir(), "aqa-e2e-"));
  env = {
    ...process.env,
    AQA_RUNS_DIR: runsDir,
    APP_BASE_URL: `http://127.0.0.1:${port}`,
    API_BASE_URL: `http://127.0.0.1:${port}`,
    TEST_USERNAME: "demo@example.com",
    TEST_PASSWORD: "demo-pass",
    TRACKER_BASE_URL: "",
    TRACKER_TOKEN: "",
  };
});

after(() => {
  app?.kill();
  if (runsDir) fs.rmSync(runsDir, { recursive: true, force: true });
});

const artifact = (name) => JSON.parse(fs.readFileSync(path.join(runsDir, RUN_ID, "artifacts", `${name}.json`), "utf8"));
const artifactExists = (name) => fs.existsSync(path.join(runsDir, RUN_ID, "artifacts", `${name}.json`));

describe("the pipeline actually executes", () => {
  test("stops at CP1 instead of running to the end", async () => {
    const r = await aqa("run", SPEC);
    const out = String(r.stdout ?? "");
    assert.match(out, /GATE CP1/);
    assert.ok(artifactExists("00-preflight"), "pre-flight must write an artifact");
    assert.ok(!artifactExists("03-case-design"), "nothing past the gate may run");
  });

  test("pre-flight really probed the app", async () => {
    const a = artifact("00-preflight");
    assert.equal(a.routes.length, 2);
    assert.ok(a.routes.every((r) => r.status === "reachable"), JSON.stringify(a.routes));
    assert.equal(a.auth.obtained, true);
  });

  test("no artifact contains a credential", () => {
    for (const f of fs.readdirSync(path.join(runsDir, RUN_ID, "artifacts"))) {
      const text = fs.readFileSync(path.join(runsDir, RUN_ID, "artifacts", f), "utf8");
      assert.doesNotMatch(text, /demo-token/, `${f} leaked the bearer token`);
      assert.doesNotMatch(text, /demo-pass/, `${f} leaked the password`);
    }
  });

  test("scope computed a confidence rather than asserting one", () => {
    const a = artifact("01-scope");
    assert.equal(a.in_scope.length, 9);
    assert.ok(a.confidence > 0 && a.confidence <= 1);
    assert.match(a.rationale, /verifiable/);
  });

  test("an unapproved gate cannot be walked past by re-running", async () => {
    await aqa("run", SPEC);
    assert.ok(!artifactExists("03-case-design"), "re-running must not advance past CP1");
  });

  test("approving lets it continue, and every scenario comes out tagged", async () => {
    await aqa("approve", RUN_ID, "CP1");
    await aqa("run", SPEC);
    const a = artifact("03-case-design");
    assert.equal(a.scenarios, 9);
    assert.deepEqual(a.untagged, [], "an untagged scenario cannot be picked by tag");
    assert.match(a.gherkin, /@area:items/);
  });

  test("publishing is a dry-run — nothing is sent without a tracker and a human", async () => {
    await aqa("approve", RUN_ID, "CP2");
    await aqa("run", SPEC);
    const a = artifact("3b-publish");
    assert.equal(a.sent, 0);
    assert.equal(a.dry_run, true);
    assert.equal(a.writes_pending.length, 9);
  });

  test("the targeted run finds the three defects planted in the demo app", async () => {
    await aqa("approve", RUN_ID, "CP3");
    await aqa("run", SPEC);
    const a = artifact("05-targeted-run");
    assert.equal(a.ran, 9);
    assert.equal(a.skipped, 0, "a skipped contract is a probe that never ran");
    const failed = a.results.filter((r) => r.verdict === "fail").map((r) => r.id).sort();
    assert.deepEqual(failed, ["DEMO-112", "DEMO-122", "DEMO-131"]);
    assert.equal(a.passed, 6);
  });

  test("each failure names exactly what differed", () => {
    const byId = Object.fromEntries(artifact("05-targeted-run").results.map((r) => [r.id, r]));
    assert.match(byId["DEMO-122"].failed.join(" "), /expected 201, got 500/);
    assert.match(byId["DEMO-131"].failed.join(" "), /expected 400 or 404, got 500/);
  });

  test("triage classifies rather than filing everything as a product bug", async () => {
    await aqa("approve", RUN_ID, "CP4");
    await aqa("run", SPEC);
    const a = artifact("06-self-heal");
    assert.equal(a.failures, 3);
    assert.equal(a.bugs_staged, 3);
    const high = a.triaged.find((t) => t.id === "DEMO-131");
    assert.equal(high.severity, "high", "a 5xx for a client mistake is the more serious class");
  });

  test("the reviewer reports on the work, and the KB entry is honest about coverage", async () => {
    await aqa("approve", RUN_ID, "CP5");
    const r = await aqa("run", SPEC);
    assert.match(String(r.stdout ?? ""), /pipeline complete/);

    const review = artifact("08-review");
    assert.ok(review.findings.length >= 4);
    assert.equal(review.blocking, 0);

    const kb = artifact("09-finalise");
    assert.equal(kb.entry.verified_against_live, null, "the run had failures, so the registry must not claim it is verified");
    assert.match(kb.note, /not stamped/);
  });

  test("a completed run with failures exits non-zero so CI can act on it", async () => {
    const r = await aqa("run", SPEC);
    assert.equal(r.code, 2, "expected exit code 2 for a run that found real failures");
  });
});

describe("resumability and rejection", () => {
  test("status reports where the run got to", async () => {
    const r = await aqa("status", RUN_ID);
    const out = String(r.stdout ?? "").replace(/\x1b\[[0-9;]*m/g, "");
    assert.match(out, /09-finalise/);
    assert.match(out, /no open gate/);
  });

  test("rejecting a gate discards the work derived from it", async () => {
    await aqa("reject", RUN_ID, "CP2", "--reason", "scope is too wide");
    assert.ok(!artifactExists("03-case-design"), "the rejected phase's artifact must go");
    assert.ok(!artifactExists("05-targeted-run"), "and everything derived from it");
    assert.ok(artifactExists("01-scope"), "but nothing before it");
  });
});

describe("failure modes are reported, not thrown", () => {
  test("a missing configuration is a clear message listing every problem", async () => {
    const r = await run("node", [ORCH, "run", SPEC], {
      cwd: repo,
      env: { ...process.env, AQA_RUNS_DIR: runsDir, APP_BASE_URL: "", API_BASE_URL: "" },
    }).catch((e) => e);
    const out = String(r.stderr ?? "") + String(r.stdout ?? "");
    assert.match(out, /APP_BASE_URL is required/);
    assert.match(out, /API_BASE_URL is required/);
    assert.equal(r.code, 1);
  });

  test("an unreachable app is a blocking finding, not a crash", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aqa-dead-"));
    const r = await run("node", [ORCH, "run", SPEC], {
      cwd: repo,
      env: { ...env, AQA_RUNS_DIR: dir, APP_BASE_URL: "http://127.0.0.1:1", API_BASE_URL: "http://127.0.0.1:1" },
    }).catch((e) => e);
    const pre = JSON.parse(fs.readFileSync(path.join(dir, RUN_ID, "artifacts", "00-preflight.json"), "utf8"));
    assert.ok(pre.routes.every((x) => x.status === "unreachable"));
    assert.ok(pre.findings.some((f) => f.severity === "blocking"));
    const scope = JSON.parse(fs.readFileSync(path.join(dir, RUN_ID, "artifacts", "01-scope.json"), "utf8"));
    assert.ok(scope.confidence < 1, "confidence must fall when the app cannot be reached");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("an invalid spec is refused with every problem listed", async () => {
    const bad = path.join(os.tmpdir(), `aqa-bad-${Date.now()}.json`);
    fs.writeFileSync(bad, JSON.stringify({ id: "spec:x", behaviours: [{ id: "A" }] }));
    const r = await run("node", [ORCH, "run", bad], { cwd: repo, env }).catch((e) => e);
    const out = String(r.stderr ?? "") + String(r.stdout ?? "");
    assert.match(out, /Spec is not usable/);
    assert.equal(r.code, 1);
    fs.rmSync(bad, { force: true });
  });
});
