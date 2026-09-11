// The experiment log.
//
// Appends, never rewrites. An experiment log whose earlier entries can be edited
// after the fact is not evidence of anything: the value is that a run which went
// badly is still sitting there when a later one goes well.
//
// Format follows the four sections the experiment asks for — baseline, failure
// analysis, iteration, retest — so the record reads as a history rather than a
// snapshot of whatever the current state happens to be.

import fs from "node:fs";
import path from "node:path";

const pct = (v) => (v === null || v === undefined ? "—" : typeof v === "number" ? v.toFixed(3) : String(v));

function header(file) {
  return `# AQA experiment log

Appended after every benchmark run. Earlier entries are never edited: a run that
went badly staying visible next to one that went well is the whole point.

Weights were pre-registered in \`pipeline/bench/weights.mjs\` before the first run,
and the ground truth in \`examples/demo-ground-truth.json\` is frozen. Neither is
changed in response to a result; if either turns out to be wrong, the revision is
recorded as a new entry that says so.

---
`;
}

export function openLog(file) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  if (!fs.existsSync(file)) fs.writeFileSync(file, header(file));

  return {
    file,

    /** Record one model's comparison. */
    record(result, {truth, verdict, change} = {}) {
      const {model, single: A, pipeline: B} = result;
      if (!A || !B) return;
      const a = A.score, b = B.score;
      const row = (label, x, y) => `| ${label} | ${pct(x)} | ${pct(y)} | ${typeof x === "number" && typeof y === "number" ? (y - x >= 0 ? "+" : "") + (y - x).toFixed(3) : "—"} |`;

      const entry = `
## ${new Date().toISOString()} · ${model}

${change ? `**Change under test:** ${change.what}\n\n**Why:** ${change.why}\n\n**Expected impact:** ${change.expected}\n` : "**Baseline run.** No change under test.\n"}
### Results

| Metric | Single agent | 12 agents | Delta |
|---|---|---|---|
${row("Real defects found", a.detection.truePositives, b.detection.truePositives)}
${row("Defects missed", a.detection.falseNegatives, b.detection.falseNegatives)}
${row("False positives", a.detection.falsePositives, b.detection.falsePositives)}
${row("Precision", a.detection.precision, b.detection.precision)}
${row("Recall", a.detection.recall, b.detection.recall)}
${row("Triage accuracy", a.triage.accuracy, b.triage.accuracy)}
${row("Requirement interpretation", a.interpretation.score, b.interpretation.score)}
${row("Correct self-corrections", a.selfCorrection.correct, b.selfCorrection.correct)}
${row("Harmful self-corrections", a.selfCorrection.harmful, b.selfCorrection.harmful)}
${row("Evidence quality", a.evidence.score, b.evidence.score)}
${row("Tokens", a.cost.inputTokens + a.cost.outputTokens, b.cost.inputTokens + b.cost.outputTokens)}
${row("Wall clock (s)", +(A.ms / 1000).toFixed(1), +(B.ms / 1000).toFixed(1))}
${row("**Weighted score**", A.overall.score, B.overall.score)}

**Verdict:** ${verdict?.call ?? "—"}${verdict?.costRatio ? ` (cost ratio ${verdict.costRatio}x)` : ""}

### Failure analysis

**Twelve agents missed:** ${b.detection.missed.length ? b.detection.missed.map((m) => `${m.id} (${m.severity}) ${m.summary}`).join("; ") : "nothing"}

**Twelve agents falsely reported:** ${b.detection.falsePositiveDetail.length ? b.detection.falsePositiveDetail.map((f) => `${f.trap ? `fell for ${f.trap.id}` : "unmatched"}: ${f.summary}`).join("; ") : "nothing"}

**Triage misclassifications:** ${b.triage.misclassified.length ? b.triage.misclassified.map((m) => `${m.observable}: called ${m.actual}, is ${m.expected}`).join("; ") : "none"}

**Interpretation probes missed:** ${b.interpretation.missed.length ? b.interpretation.missed.join("; ") : "none"}

**Phases that errored:** ${B.phaseFailures?.length ? B.phaseFailures.map((f) => `${f.phase}: ${f.error}`).join("; ") : "none"}

**Single agent missed:** ${a.detection.missed.length ? a.detection.missed.map((m) => m.id).join(", ") : "nothing"}
**Single agent falsely reported:** ${a.detection.falsePositiveDetail.length ? a.detection.falsePositiveDetail.map((f) => f.summary).join("; ") : "nothing"}

---
`;
      fs.appendFileSync(file, entry);
      return entry;
    },

    /** Record a change made between runs, before the retest. */
    iteration({what, why, expected, phase}) {
      fs.appendFileSync(file, `
## ${new Date().toISOString()} · iteration

**Changed:** ${what}
**Where:** ${phase ?? "—"}
**Why:** ${why}
**Expected impact:** ${expected}

_Retest follows below._

---
`);
    },
  };
}
