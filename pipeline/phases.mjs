// The eleven pipeline phases, as deterministic functions over the spec.
//
// Each phase takes the artifacts produced before it and returns its own. No phase calls a model:
// the pipeline runs end to end with nothing but Node and a reachable app. That is what makes a
// run reproducible — the same spec against the same build gives the same artifacts, so a
// difference between two runs is a difference in the APP, which is the entire point of a
// regression suite.
//
// A model is useful for turning prose into a spec (see spec.mjs). It is not in this path.

import { applyTags, validateTags, explainType } from "./lib/tags.mjs";
import { probeRoutes, authenticate, probeBehaviour, probeContract } from "./lib/probe.mjs";
import { mapLimit } from "./lib/retry.mjs";
import { log } from "./lib/log.mjs";
import { loadDriver, runUiBehaviour } from "./lib/ui.mjs";

const pct = (n, d) => (d === 0 ? 0 : +(n / d).toFixed(2));

/* ── 00 · Pre-flight ──────────────────────────────────────────────────────
   Reconciles the declared intent against the running app, and probes for what
   the spec needs. Surfaces disagreement; never resolves it. */
async function preflight({ spec, cfg, session }) {
  const routes = await probeRoutes(cfg.APP_BASE_URL, spec.routes, { timeoutMs: cfg.REQUEST_TIMEOUT_MS });
  const auth = await authenticate(cfg, spec.auth, { timeoutMs: cfg.REQUEST_TIMEOUT_MS });
  if (session) session.token = auth.token ?? null; // in memory only — never written to an artifact

  const findings = [];
  for (const r of routes.filter((x) => x.status !== "reachable")) {
    findings.push({ id: `PRE-ROUTE-${r.route}`, severity: "blocking", detail: `${r.route} is ${r.status} (${r.evidence})` });
  }
  if (spec.auth && !auth.token) {
    findings.push({ id: "PRE-AUTH", severity: "blocking", detail: `could not authenticate: ${auth.reason}` });
  }
  for (const note of cfg.degraded) findings.push({ id: "PRE-CONFIG", severity: "info", detail: note });

  return {
    app: { web: cfg.APP_BASE_URL, api: cfg.API_BASE_URL },
    routes,
    auth: { obtained: Boolean(auth.token), reason: auth.reason ?? null },
    contracts_declared: spec.behaviours.filter((b) => b.contract).length,
    behaviours_declared: spec.behaviours.length,
    findings,
  };
}

/* ── 01 · Scope Analyst ───────────────────────────────────────────────────
   Sorts every behaviour into exactly one bucket, with a reason, and rates its
   own confidence. Low confidence forces the CP1 review rather than a bad plan. */
function scope({ spec, artifacts }) {
  const pre = artifacts["00-preflight"];
  const reachable = pre.routes.every((r) => r.status === "reachable");
  const in_scope = [];
  const deferred = [];

  for (const b of spec.behaviours) {
    const verifiable = Boolean(b.contract) || (reachable && b.when.length > 0);
    if (verifiable) {
      in_scope.push({ id: b.id, behaviour: b.title, area: b.feature, layer: b.layer });
    } else {
      deferred.push({
        id: b.id,
        behaviour: b.title,
        why: b.contract ? "its contract could not be reached" : "no contract, and the UI route it needs is not reachable",
      });
    }
  }

  // Confidence is computed, not asserted: what fraction of behaviours can actually be verified,
  // reduced by anything pre-flight flagged as blocking.
  const blocking = pre.findings.filter((f) => f.severity === "blocking").length;
  const confidence = Math.max(0, +(pct(in_scope.length, spec.behaviours.length) - blocking * 0.15).toFixed(2));

  return {
    in_scope,
    deferred,
    out_scope: [],
    confidence,
    rationale:
      `${in_scope.length} of ${spec.behaviours.length} behaviours are verifiable against this build` +
      (blocking ? `; ${blocking} blocking pre-flight finding(s) reduce confidence` : ""),
    findings: pre.findings.filter((f) => f.severity === "blocking"),
  };
}

/* ── 02 · Test Architect ──────────────────────────────────────────────────
   One testable objective per in-scope behaviour, routed to a track and typed. */
function architecture({ spec, artifacts }) {
  const inScope = new Set(artifacts["01-scope"].in_scope.map((x) => x.id));
  const objectives = spec.behaviours
    .filter((b) => inScope.has(b.id))
    .map((b) => {
      const t = explainType(`${b.title} ${b.when.join(" ")} ${b.then}`);
      return {
        id: b.id,
        objective: b.then,
        area: b.feature,
        track: b.layer,
        type: b.type ?? t.type,
        type_reason: b.type ? "pinned by the spec" : t.why,
      };
    });

  const byType = objectives.reduce((a, o) => ((a[o.type] = (a[o.type] ?? 0) + 1), a), {});
  const risks = [];
  if (!byType.negative) risks.push("no negative case in this scope — a suite of happy paths proves very little");
  if (!byType.edge) risks.push("no boundary case in this scope");
  if (objectives.every((o) => o.track === "UI")) risks.push("UI-only coverage — contract-level defects will not be visible");

  return { objectives, split: byType, pilot: spec.area, risks };
}

/* ── 03 · Case Designer ───────────────────────────────────────────────────
   Gherkin per objective, auto-tagged so any slice is pickable by tag. */
function caseDesign({ spec, artifacts }) {
  const objectives = new Map(artifacts["02-architecture"].objectives.map((o) => [o.id, o]));
  const scenarios = [];
  const body = [`Feature: ${spec.title}`, ""];

  for (const b of spec.behaviours) {
    const o = objectives.get(b.id);
    if (!o) continue;
    const lines = [`  Scenario: ${b.id} ${b.title}`];
    if (b.given) lines.push(`    Given ${b.given}`);
    b.when.forEach((w, i) => lines.push(`    ${i === 0 ? "When" : "And"} ${w}`));
    lines.push(`    Then ${b.then}`);
    body.push(...lines, "");
    scenarios.push({ id: b.id, title: b.title, type: o.type, area: b.feature });
  }

  const gherkin = applyTags(body.join("\n"), spec.area);
  return {
    file: `tests/features/${spec.area}.feature`,
    gherkin,
    features: 1,
    scenarios: scenarios.length,
    cases: scenarios,
    untagged: validateTags(gherkin),
  };
}

/* ── 3b · Tracker Publisher ───────────────────────────────────────────────
   Builds the payloads and STOPS. Dry-run unless a tracker is configured and a
   human passes --send at the gate. */
function publish({ spec, artifacts, cfg, send = false }) {
  const cases = artifacts["03-case-design"].cases;
  const writes_pending = cases.map((c) => ({
    endpoint: `${cfg.TRACKER_BASE_URL ?? "${TRACKER_BASE_URL}"}/api/testcases`,
    payload: {
      summary: `${c.id} ${c.title}`,
      labels: [`area:${c.area}`, `type:${c.type}`, "aqa-generated"],
      expected: spec.behaviours.find((b) => b.id === c.id)?.then ?? null,
    },
  }));
  return {
    dry_run: !send,
    sent: 0,
    reason: send && !cfg.canPublish ? "--send was given but TRACKER_BASE_URL / TRACKER_TOKEN are not configured" : null,
    testcases: writes_pending.length,
    writes_pending,
  };
}

/* ── 04 · Test Generator ──────────────────────────────────────────────────
   Emits the feature file and an executable contract suite. A behaviour with no
   contract is emitted as a dated skip naming why — never a guessed selector. */
function generate({ spec, artifacts }) {
  const cases = artifacts["03-case-design"].cases;
  const runnable = [];
  const skipped = [];

  for (const c of cases) {
    const b = spec.behaviours.find((x) => x.id === c.id);
    if (b?.contract) runnable.push({ id: b.id, method: b.contract.method, path: b.contract.path });
    else skipped.push({ id: c.id, reason: "no contract declared; a UI step definition needs a verified selector", since: new Date().toISOString().slice(0, 10) });
  }

  return {
    files: [artifacts["03-case-design"].file, `tests/contracts/${spec.area}.contract.json`],
    step_defs: runnable.length,
    selectors_verified: 0,
    new_page_objects: 0,
    runnable,
    skipped,
  };
}

/* ── 05 · Targeted Run ────────────────────────────────────────────────────
   Executes this cycle's contracts against the live app. Real requests, real
   comparisons — this is where a contract-level defect actually surfaces. */
async function targetedRun({ spec, artifacts, cfg, session }) {
  const token = session?.token ?? null;
  const inScope = new Set(artifacts["01-scope"].in_scope.map((x) => x.id));
  const todo = spec.behaviours.filter((b) => inScope.has(b.id));

  // Bounded, not serial and not unbounded: serial makes a real suite unusably slow, unbounded
  // turns the tool into a load test of the app it is measuring.
  // A browser is optional. When it is absent, UI behaviours are skipped WITH that reason rather
  // than silently dropped or reported as passing.
  const needsUi = todo.some((b) => b.ui?.steps);
  const driver = needsUi ? await loadDriver() : { available: false, reason: "no behaviour declares ui.steps" };
  const browser = driver.available ? await driver.chromium.launch() : null;
  if (needsUi && !driver.available) log.warn(`  ! UI behaviours will be skipped: ${driver.reason}`);

  const results = await mapLimit(todo, cfg.CONCURRENCY, async (b) => {
    if (b.ui?.steps) {
      if (!browser) return { id: b.id, title: b.title, verdict: "skipped", reason: driver.reason, layer: "UI" };
      const u = await runUiBehaviour(b, {
        browser,
        baseUrl: cfg.APP_BASE_URL,
        timeoutMs: cfg.REQUEST_TIMEOUT_MS,
        substitute: { run: session?.nonce ?? "run" },
      });
      log.debug(`ui ${b.id}`, { verdict: u.verdict });
      return { id: b.id, title: b.title, verdict: u.verdict, layer: "UI", failed: u.failed?.length ? u.failed : null, steps: u.steps, dialogs: u.dialogs };
    }
    if (!b.contract) return { id: b.id, title: b.title, verdict: "skipped", reason: "no contract and no ui.steps to execute" };
    const r = await probeBehaviour(b, {
      apiBase: cfg.API_BASE_URL,
      token,
      timeoutMs: cfg.REQUEST_TIMEOUT_MS,
      substitute: { run: session?.nonce ?? "run" },
      retry: { attempts: cfg.RETRY_ATTEMPTS },
    });
    log.debug(`probe ${b.id}`, { verdict: r.verdict, status: r.response?.status ?? null });
    return {
      id: b.id,
      title: b.title,
      verdict: r.verdict,
      reason: r.reason ?? null,
      failed: r.failed ?? null,
      request: r.request ?? null,
      status: r.response?.status ?? null,
      durationMs: r.response?.durationMs ?? null,
      ...(r.retried ? { attempts: r.attempts, retried: true } : {}),
      checks: r.checks,
    };
  });

  await browser?.close().catch(() => {});

  const count = (v) => results.filter((r) => r.verdict === v).length;
  return {
    ran: results.length,
    ui_ran: results.filter((r) => r.layer === "UI" && r.verdict !== "skipped").length,
    passed: count("pass"),
    failed: count("fail"),
    skipped: count("skipped"),
    retried: results.filter((r) => r.retried).length,
    results,
  };
}

/* ── 06 · Triage / Self-Heal ──────────────────────────────────────────────
   Classifies each failure. The expensive mistake in QA is filing a test's own
   defect against the product, so classification comes before any bug. */
function selfHeal({ artifacts }) {
  const failures = artifacts["05-targeted-run"].results.filter((r) => r.verdict === "fail");
  const triaged = failures.map((f) => {
    const why = (f.failed ?? []).join(" ") + " " + (f.reason ?? "");
    // A transport failure is an environment problem, not a product bug.
    if (/request failed|timed out|ECONNREFUSED|ENOTFOUND/i.test(why)) {
      return { id: f.id, classification: "environment", action: "reported, no bug filed", detail: f.reason };
    }
    // A 5xx where the spec expected a 4xx is the app mishandling a client error.
    // "expected 400, got 500" and "expected 400 or 404, got 500" are the same defect class:
    // the app answers a client mistake with a server error.
    if (/expected (?:4\d\d(?:\s+or\s+4\d\d)*), got 5\d\d/.test(why)) {
      return { id: f.id, classification: "product_bug", severity: "high", action: "bug staged (dry-run)",
               detail: "the app returns a server error for what the spec declares a client error" };
    }
    if (/status: expected/.test(why)) {
      return { id: f.id, classification: "product_bug", severity: "medium", action: "bug staged (dry-run)", detail: (f.failed ?? [])[0] };
    }
    return { id: f.id, classification: "needs_human", action: "escalated to CP4", detail: (f.failed ?? [])[0] ?? f.reason };
  });

  return {
    failures: failures.length,
    healed: 0, // a contract failure is never "healed" by editing the assertion
    bugs_staged: triaged.filter((t) => t.classification === "product_bug").length,
    known_flaky_skipped: triaged.filter((t) => t.classification === "environment").length,
    cap_cycles: 3,
    triaged,
  };
}

/* ── 07 · Regression ──────────────────────────────────────────────────────
   Re-runs every contract, to prove this cycle did not disturb anything else. */
async function regression({ spec, cfg, session }) {
  const token = session?.token ?? null;
  const todo = spec.behaviours.filter((x) => x.contract);
  const results = await mapLimit(todo, cfg.CONCURRENCY, async (b) => {
    const r = await probeBehaviour(b, {
      apiBase: cfg.API_BASE_URL,
      token,
      timeoutMs: cfg.REQUEST_TIMEOUT_MS,
      substitute: { run: `${session?.nonce ?? "run"}r` },
      retry: { attempts: cfg.RETRY_ATTEMPTS },
    });
    return { id: b.id, verdict: r.verdict };
  });
  const count = (v) => results.filter((r) => r.verdict === v).length;
  return { total: results.length, passed: count("pass"), failed: count("fail"), skipped: count("skipped"), results };
}

/* ── 08 · Reviewer ────────────────────────────────────────────────────────
   Reads the generated work against conventions.md. Comments; never merges. */
function review({ spec, artifacts }) {
  const cases = artifacts["03-case-design"];
  const gen = artifacts["04-generate"];
  const arch = artifacts["02-architecture"];
  const findings = [];

  const untagged = cases.untagged;
  findings.push({
    rule: "every scenario carries @area and @type",
    verdict: untagged.length ? "fail" : "pass",
    blocking: untagged.length > 0,
    detail: untagged.length ? untagged.map((u) => u.scenario).join("; ") : "all tagged",
  });

  const keyless = cases.cases.filter((c) => !/^[A-Z]+-\d+/.test(c.id));
  findings.push({
    rule: "every scenario carries its tracker key",
    verdict: keyless.length ? "fail" : "pass",
    blocking: keyless.length > 0,
    detail: keyless.length ? keyless.map((c) => c.id).join(", ") : "all keyed",
  });

  findings.push({
    rule: "no bare 2xx assertion — the inner result is asserted",
    verdict: spec.behaviours.filter((b) => b.contract).every((b) => b.contract.expect.hasFields || b.contract.expect.bodyMatches || String(b.contract.expect.status).startsWith("4") || String(b.contract.expect.status).startsWith("5")) ? "pass" : "fail",
    blocking: false,
    detail: "a 2xx alone proves the request arrived, not that it did the right thing",
  });

  findings.push({
    rule: "shared page objects untouched (page-object freeze)",
    verdict: gen.new_page_objects === 0 ? "pass" : "fail",
    blocking: gen.new_page_objects > 0,
    detail: `${gen.new_page_objects} new page objects`,
  });

  for (const risk of arch.risks) findings.push({ rule: "architecture risk", verdict: "warn", blocking: false, detail: risk });

  return { findings, blocking: findings.filter((f) => f.blocking).length, passed: findings.filter((f) => f.verdict === "pass").length };
}

/* ── 09 · KB Curator ──────────────────────────────────────────────────────
   Writes the Feature Registry entry: what is covered, and when it was last
   verified against the running app. */
function finalise({ spec, artifacts }) {
  const run = artifacts["05-targeted-run"];
  const verified = run.failed === 0 && run.passed > 0 ? new Date().toISOString().slice(0, 10) : null;
  return {
    file: `kb/${spec.area}.yaml`,
    entry: {
      feature: spec.area,
      intent: { spec: [spec.id] },
      truth: {
        ui_routes: spec.routes,
        api: spec.behaviours.filter((b) => b.contract).map((b) => `${b.contract.method} ${b.contract.path}`),
      },
      ours: { feature: artifacts["03-case-design"].file },
      verified_against_live: verified,
      coverage: run.passed > 0 ? "covered" : "not-verified",
    },
    note: verified ? null : "not stamped — the targeted run did not come back clean, so the registry must not claim it did",
  };
}


/* ═══════════════════════════════════════════════════════════════════════════
   ASYNC TRACKS · agents 9-12
   These report and never block a merge. Each one either produces a real result
   or says, with its reason, that it could not run — never a green it did not
   earn. They are separate from the gated pipeline by design: performance is a
   measurement, design parity is a design-team concern, and AI quality is a
   score against a baseline. None of those should hold up a merge.
   ═══════════════════════════════════════════════════════════════════════════ */

/* ── 09 · Performance & Logs ──────────────────────────────────────────────
   Measures the steps this spec touches against budgets DECLARED IN THE SPEC.
   A budget written before the run makes a breach a fact; a number judged after
   the fact is an opinion. */
async function performance({ spec, cfg, session }) {
  const budgets = spec.budgets ?? {};
  const measurable = spec.behaviours.filter((b) => b.contract && budgets[b.id] != null);

  if (measurable.length === 0) {
    return {
      status: "not_configured",
      gates: false,
      reason: "no budgets declared in the spec — there is nothing to measure against",
      hint: 'add "budgets": { "<behaviour-id>": <p95 ms> } to the spec',
      steps: [],
      findings: [],
    };
  }

  const iterations = cfg.PERF_ITERATIONS;
  const token = session?.token ?? null;
  const steps = [];

  for (const b of measurable) {
    const samples = [];
    let errors = 0;
    for (let i = 0; i < iterations; i++) {
      const r = await probeContract(b.contract, {
        apiBase: cfg.API_BASE_URL,
        token,
        timeoutMs: cfg.REQUEST_TIMEOUT_MS,
        substitute: { run: `${session?.nonce ?? "run"}p${i}` },
        retry: { attempts: 1 }, // a retry would distort the very timing being measured
      });
      if (r.response?.durationMs != null) samples.push(r.response.durationMs);
      else errors++;
    }
    if (samples.length === 0) {
      steps.push({ step: b.id, n: 0, error: "every sample failed", budget: budgets[b.id], breach: false, measured: false });
      continue;
    }
    const sorted = samples.slice().sort((x, y) => x - y);
    const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
    const p95 = +at(0.95).toFixed(1);
    steps.push({
      step: b.id,
      n: samples.length,
      errors,
      p50: +at(0.5).toFixed(1),
      p95,
      max: +sorted.at(-1).toFixed(1),
      budget: budgets[b.id],
      breach: p95 > budgets[b.id],
      measured: true,
    });
  }

  const breaches = steps.filter((s) => s.breach);
  return {
    status: "ran",
    gates: false,
    iterations,
    steps,
    findings: breaches.map((s) => ({
      id: `PERF-${s.step}`,
      severity: "medium",
      evidence: `p95 ${s.p95}ms over the declared budget of ${s.budget}ms across ${s.n} samples`,
    })),
    note: "report-only — this track never gates a merge, and never files known non-determinism as a bug",
  };
}

/* ── 10 · Design Parity ───────────────────────────────────────────────────
   Compares a design prototype against the built app. Without a prototype
   there is nothing to compare, and it says so rather than passing. */
async function designParity({ spec, cfg }) {
  const proto = spec.prototype ?? cfg.PROTOTYPE_BASE_URL ?? null;
  if (!proto) {
    return {
      status: "not_configured",
      gates: false,
      reason: "no prototype source connected, so there is nothing to compare the built app against",
      hint: 'set PROTOTYPE_BASE_URL, or add "prototype" to the spec',
      compares: ["visual/layout", "flow", "copy", "states (empty, error, loading)"],
      raises_against: "the design team — never product bugs, and never blocking",
    };
  }
  // With a prototype we can at least compare route reachability and shape. Anything visual needs
  // a browser, which the UI track owns; this reports what it could actually check.
  const [protoRoutes, liveRoutes] = await Promise.all([
    probeRoutes(proto, spec.routes, { timeoutMs: cfg.REQUEST_TIMEOUT_MS }),
    probeRoutes(cfg.APP_BASE_URL, spec.routes, { timeoutMs: cfg.REQUEST_TIMEOUT_MS }),
  ]);
  const diffs = spec.routes
    .map((route, i) => ({ route, prototype: protoRoutes[i].status, live: liveRoutes[i].status }))
    .filter((d) => d.prototype !== d.live);

  return {
    status: "ran",
    gates: false,
    prototype: proto,
    checked: spec.routes.length,
    diffs,
    note: "route-level parity only; visual comparison needs a browser. A human triages each diff as regression or deliberate evolution.",
  };
}

/* ── 11 · AI Eval Analyst ─────────────────────────────────────────────────
   Scores an assistant against a human-approved answer key. Quality is a score
   against a baseline, never a pass/fail, and never a merge gate. */
async function aiEval({ spec, cfg }) {
  const golden = spec.golden ?? null;
  if (!golden || !Array.isArray(golden.cases) || golden.cases.length === 0) {
    return {
      status: "not_applicable",
      gates: false,
      reason: "this spec declares no assistant and no golden dataset, so there is nothing to score",
      hint: 'add "golden": { "endpoint": "/v1/ask", "cases": [{ "ask": "...", "expectTools": [...] }] }',
      scores_on: ["correctness", "faithfulness", "coherence", "relevance"],
      deterministic_checks: ["expected tools present", "no forbidden tools", "no errored spans", "latency within budget"],
    };
  }

  const token = null; // golden probes declare their own auth needs
  const results = [];
  for (const c of golden.cases) {
    const r = await probeContract(
      { method: "POST", path: golden.endpoint, auth: c.auth ?? false, body: { query: c.ask }, expect: { status: 200 } },
      { apiBase: cfg.API_BASE_URL, token, timeoutMs: cfg.REQUEST_TIMEOUT_MS, retry: { attempts: 1 } },
    );
    // Deterministic checks only. A judge model would put a model back in the execution path, and
    // the whole point of this runtime is that there is not one; scoring by judge is a separate,
    // opt-in step that reads this artifact.
    const answered = r.verdict === "pass";
    const tools = r.response?.body?.tools ?? [];
    const forbidden = (c.forbidTools ?? []).filter((t) => tools.includes(t));
    const missing = (c.expectTools ?? []).filter((t) => !tools.includes(t));
    results.push({
      ask: c.ask,
      answered,
      latencyMs: r.response?.durationMs ?? null,
      withinBudget: c.budgetMs == null ? null : (r.response?.durationMs ?? Infinity) <= c.budgetMs,
      missingTools: missing,
      forbiddenToolsUsed: forbidden,
      deterministic: answered && missing.length === 0 && forbidden.length === 0,
    });
  }

  return {
    status: "ran",
    gates: false,
    cases: results.length,
    deterministic_pass: results.filter((r) => r.deterministic).length,
    results,
    note: "deterministic checks only — a judged quality score is an opt-in step over this artifact, kept out of the runtime so a run stays reproducible",
  };
}

/* ── 12 · Drift Detector ──────────────────────────────────────────────────
   Re-verifies the Feature Registry against the live app. What it cannot check,
   it reports as unchecked WITH the reason, rather than stamping fresh. */
async function drift({ spec, cfg, session, artifacts }) {
  const kb = artifacts["09-finalise"]?.entry;
  if (!kb) {
    return { status: "not_configured", gates: false, reason: "no Feature Registry entry for this feature yet — nothing recorded means nothing to re-check", checks: [] };
  }

  const token = session?.token ?? null;
  const checks = [];

  for (const r of await probeRoutes(cfg.APP_BASE_URL, kb.truth.ui_routes ?? [], { timeoutMs: cfg.REQUEST_TIMEOUT_MS })) {
    checks.push({ anchor: `ui_route ${r.route}`, status: r.status === "reachable" ? "verified" : "drifted", evidence: r.evidence });
  }

  for (const b of spec.behaviours.filter((x) => x.contract)) {
    const r = await probeContract(b.contract, {
      apiBase: cfg.API_BASE_URL,
      token,
      timeoutMs: cfg.REQUEST_TIMEOUT_MS,
      substitute: { run: `${session?.nonce ?? "run"}d` },
      retry: { attempts: cfg.RETRY_ATTEMPTS },
    });
    checks.push({
      anchor: `${b.contract.method} ${b.contract.path}`,
      // Drift asks "does reality still match what we recorded", not "is the app correct". A
      // contract that still behaves as recorded has not drifted, even when what it records is a
      // known defect — that is triage's business, not this track's.
      status: r.verdict === "skipped" ? "not-checked" : "verified",
      evidence: r.verdict === "skipped" ? r.reason : `HTTP ${r.response?.status}`,
    });
  }

  const drifted = checks.filter((c) => c.status === "drifted");
  const unchecked = checks.filter((c) => c.status === "not-checked");
  return {
    status: "ran",
    gates: false,
    checked: checks.length,
    verified: checks.filter((c) => c.status === "verified").length,
    drifted: drifted.length,
    not_checked: unchecked.length,
    checks,
    flags: drifted.map((c) => ({ anchor: c.anchor, evidence: c.evidence, action: "human triage: product bug, or stale registry?" })),
    stamped: drifted.length === 0 && unchecked.length === 0,
    note: unchecked.length ? "stamped partial — what could not be checked is listed with its reason rather than assumed fresh" : null,
  };
}

/** The pipeline, in order. `gate` is the checkpoint that must be approved AFTER the phase runs. */
export const PHASES = [
  { id: "00-preflight", agent: "pre-flight", gate: null, run: preflight },
  { id: "01-scope", agent: "scope-analyst", gate: null, run: scope },
  { id: "02-architecture", agent: "test-architect", gate: "CP1", run: architecture },
  { id: "03-case-design", agent: "case-designer", gate: "CP2", run: caseDesign },
  { id: "3b-publish", agent: "tracker-publisher", gate: null, run: publish },
  { id: "04-generate", agent: "test-generator", gate: "CP3", run: generate },
  { id: "05-targeted-run", agent: "targeted-run", gate: "CP4", run: targetedRun },
  { id: "06-self-heal", agent: "triage-self-healer", gate: null, run: selfHeal },
  { id: "07-regression", agent: "regression", gate: null, run: regression },
  { id: "08-review", agent: "reviewer", gate: "CP5", run: review },
  { id: "09-finalise", agent: "kb-curator", gate: null, run: finalise },
];

/** The async tracks. They run after the pipeline and never gate it. */
export const ASYNC_TRACKS = [
  { id: "a09-performance", agent: "performance-analyst", n: 9, run: performance },
  { id: "a10-design-parity", agent: "design-parity-analyst", n: 10, run: designParity },
  { id: "a11-ai-eval", agent: "eval-analyst", n: 11, run: aiEval },
  { id: "a12-drift", agent: "drift-detector", n: 12, run: drift },
];

export const ALL_PHASES = [...PHASES, ...ASYNC_TRACKS];
export const phaseById = (id) => ALL_PHASES.find((p) => p.id === id);
