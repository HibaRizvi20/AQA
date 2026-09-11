// The deterministic half.
//
// Everything here is a mechanical operation an agent asked for. None of it makes
// a QA decision: it does not choose what is worth testing, does not interpret a
// result, and does not decide whether a failure is the test's fault.
//
// The division that matters:
//
//   an agent decides   what to run, what it means, what to do about it
//   this file does     run it, measure it, record it, and report exactly what happened
//
// The most important consequence is in executeCases. A verdict is produced HERE,
// from a real request or a real browser step, never by a model describing what it
// thinks would have happened. An agent cannot report a pass it did not earn,
// because it is not the thing that writes the verdict.

import {probeBehaviour} from "./probe.mjs";
import {loadDriver, runUiBehaviour} from "./ui.mjs";
import {mapLimit} from "./retry.mjs";
import {log} from "./log.mjs";

/**
 * Run a selection of cases and produce verdicts.
 *
 * `cases` is what an agent chose to run, each carrying either a `contract` (API)
 * or `ui.steps` (browser). A case with neither is reported as skipped WITH that
 * reason — never as a pass, and never quietly dropped.
 */
export async function executeCases(cases, ctx) {
  const list = Array.isArray(cases) ? cases : [];
  const needsUi = list.some((c) => c?.ui?.steps?.length);
  const driver = needsUi ? await loadDriver() : {available: false, reason: "no case declares ui.steps"};
  const browser = driver.available ? await driver.chromium.launch() : null;
  if (needsUi && !browser) log.warn(`  ! UI cases will be skipped: ${driver.reason}`);

  const probeCtx = {
    apiBase: ctx.cfg.API_BASE_URL,
    token: ctx.session?.token ?? null,
    timeoutMs: ctx.cfg.REQUEST_TIMEOUT_MS,
    retry: {attempts: ctx.cfg.RETRY_ATTEMPTS},
  };

  try {
    const results = await mapLimit(list, ctx.cfg.CONCURRENCY, async (c, i) => {
      const id = c?.id ?? `case-${i + 1}`;
      const nonce = `${ctx.session?.nonce ?? "run"}${i}`;

      if (c?.ui?.steps?.length) {
        if (!browser) return {id, title: c.title ?? null, layer: "UI", verdict: "skipped", reason: driver.reason};
        const u = await runUiBehaviour(c, {
          browser,
          baseUrl: ctx.cfg.APP_BASE_URL,
          timeoutMs: ctx.cfg.REQUEST_TIMEOUT_MS,
          substitute: {run: nonce},
        });
        return {
          id, title: c.title ?? null, layer: "UI",
          verdict: u.verdict,
          failed: u.failed?.length ? u.failed : null,
          steps: u.steps,
          dialogs: u.dialogs,
        };
      }

      if (c?.contract) {
        const r = await probeBehaviour(c, {...probeCtx, substitute: {run: nonce}});
        return {
          id, title: c.title ?? null, layer: "API",
          verdict: r.verdict,
          reason: r.reason ?? null,
          failed: r.failed ?? null,
          request: r.request ?? null,
          status: r.response?.status ?? null,
          durationMs: r.response?.durationMs ?? null,
          ...(r.retried ? {attempts: r.attempts, retried: true} : {}),
          checks: r.checks ?? null,
        };
      }

      return {
        id, title: c?.title ?? null, layer: null, verdict: "skipped",
        reason: "the case carries neither a contract nor ui.steps, so nothing could execute it",
      };
    });

    const n = (v) => results.filter((r) => r.verdict === v).length;
    return {ran: results.length, passed: n("pass"), failed: n("fail"), skipped: n("skipped"), results};
  } finally {
    await browser?.close().catch(() => {});
  }
}

/**
 * Time a case repeatedly and compare against a declared budget.
 * Retries are off: a retry would distort the timing being measured.
 */
export async function measure(cases, budgets, ctx) {
  const steps = [];
  for (const c of cases) {
    const budget = budgets?.[c.id];
    if (budget == null || !c.contract) continue;

    const samples = [];
    let errors = 0;
    for (let i = 0; i < ctx.cfg.PERF_ITERATIONS; i++) {
      const r = await probeBehaviour(c, {
        apiBase: ctx.cfg.API_BASE_URL,
        token: ctx.session?.token ?? null,
        timeoutMs: ctx.cfg.REQUEST_TIMEOUT_MS,
        substitute: {run: `${ctx.session?.nonce ?? "run"}p${i}`},
        retry: {attempts: 1},
      });
      if (r.response?.durationMs != null) samples.push(r.response.durationMs);
      else errors++;
    }
    if (samples.length === 0) {
      steps.push({step: c.id, n: 0, errors, budget, breach: false, measured: false, error: "every sample failed"});
      continue;
    }
    const sorted = samples.slice().sort((a, b) => a - b);
    const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
    const p95 = +at(0.95).toFixed(1);
    steps.push({
      step: c.id, n: samples.length, errors,
      p50: +at(0.5).toFixed(1), p95, max: +sorted.at(-1).toFixed(1),
      budget, breach: p95 > budget, measured: true,
    });
  }
  return steps;
}

/**
 * Re-verify registry anchors against the live app.
 * Reports what it could not check rather than assuming it still holds.
 */
export async function verifyAnchors(anchors, ctx) {
  const {probeRoutes} = await import("./probe.mjs");
  const checks = [];

  for (const r of await probeRoutes(ctx.cfg.APP_BASE_URL, anchors.routes ?? [], {timeoutMs: ctx.cfg.REQUEST_TIMEOUT_MS})) {
    checks.push({
      anchor: `ui_route ${r.route}`,
      status: r.status === "reachable" ? "verified" : "drifted",
      evidence: r.evidence,
    });
  }

  for (const c of anchors.contracts ?? []) {
    const r = await probeBehaviour({id: c.id ?? "anchor", contract: c.contract ?? c}, {
      apiBase: ctx.cfg.API_BASE_URL,
      token: ctx.session?.token ?? null,
      timeoutMs: ctx.cfg.REQUEST_TIMEOUT_MS,
      substitute: {run: `${ctx.session?.nonce ?? "run"}d`},
      retry: {attempts: ctx.cfg.RETRY_ATTEMPTS},
    });
    checks.push({
      anchor: `${(c.contract ?? c).method} ${(c.contract ?? c).path}`,
      status: r.verdict === "skipped" ? "not-checked" : r.verdict === "pass" ? "verified" : "drifted",
      evidence: r.verdict === "skipped" ? r.reason : `HTTP ${r.response?.status ?? "—"}`,
    });
  }

  for (const a of anchors.unverifiable ?? []) {
    checks.push({anchor: a.anchor, status: "not-checked", evidence: a.reason});
  }
  return checks;
}

/**
 * Build the tracker payloads for the cases an agent chose to publish.
 *
 * The agent decides WHICH cases and what each one says. This builds the exact
 * records, so a model never shapes an outbound write to a real tracker by hand.
 */
export function buildTrackerWrites(selected, cfg) {
  const base = cfg.TRACKER_BASE_URL ?? "${TRACKER_BASE_URL}";
  return (selected ?? []).map((c) => ({
    endpoint: `${base}/api/testcases`,
    payload: {
      summary: `${c.id} ${c.title}`,
      labels: [`area:${c.area}`, `type:${c.type}`, "aqa-generated"],
      preconditions: c.preconditions ?? null,
      steps: c.steps ?? [],
      expected: c.expected ?? null,
    },
  }));
}

/** Persist a file an agent produced, inside the project only. */
export async function writeArtifactFile(repoRoot, relPath, content) {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const abs = path.resolve(repoRoot, relPath);
  if (!abs.startsWith(path.resolve(repoRoot) + path.sep)) {
    throw new Error(`refusing to write outside the project: ${relPath}`);
  }
  fs.mkdirSync(path.dirname(abs), {recursive: true});
  fs.writeFileSync(abs, content);
  return {written: relPath, bytes: content.length};
}
