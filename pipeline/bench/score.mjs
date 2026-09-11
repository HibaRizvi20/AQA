// Scoring one architecture's run against ground truth.
//
// The scorer is the instrument, so it is the thing most worth being sceptical
// about. If it is wrong, every number downstream is wrong and confidently so.
// It is therefore pure, dependency-free and tested against hand-built fixtures
// where the right answer is known by construction.
//
// Two rules it holds to:
//
//   A report is credited ONLY against a planted defect it genuinely matches.
//   Anything else is a false positive, including a report that is merely vague.
//
//   Silence is not precision. A system that reports nothing scores 0 on recall,
//   and its precision is reported as null rather than a flattering 1.

const norm = (s) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();

/** Does a reported defect genuinely name this planted one? */
export function matchesDefect(reported, gt) {
  const hay = norm([reported.id, reported.summary, reported.evidence, reported.area, reported.detail].join(" "));
  if (!hay) return false;
  const keys = gt.accept_if_mentions ?? [];
  // Two independent signals, so a single incidental word cannot claim a defect.
  const hits = keys.filter((k) => hay.includes(norm(k))).length;
  return hits >= (gt.require_signals ?? 2);
}

/** Does a reported defect actually describe a behaviour that is correct? */
export function matchesTrap(reported, trap) {
  const hay = norm([reported.summary, reported.evidence, reported.detail].join(" "));
  const keys = trap.recognise_if_mentions ?? [];
  return keys.some((k) => hay.includes(norm(k)));
}

/* ── 1 & 2 · recall and precision ────────────────────────────────────────── */

export function scoreDetection(reported = [], truth) {
  const found = [];
  const missed = [];
  const credited = new Set();

  for (const gt of truth.defects) {
    const hit = reported.find((r) => matchesDefect(r, gt));
    if (hit) {
      found.push({id: gt.id, severity: gt.severity, summary: gt.summary, matchedBy: hit.summary ?? hit.id});
      credited.add(hit);
    } else {
      missed.push({id: gt.id, severity: gt.severity, summary: gt.summary});
    }
  }

  // Everything not credited to a real defect is a false positive. A report that
  // names a known-correct behaviour is labelled with the trap it fell into,
  // because "which trap" is more useful than a bare count.
  const falsePositives = reported
    .filter((r) => !credited.has(r))
    .map((r) => {
      const trap = truth.correct_behaviours.find((ok) => matchesTrap(r, ok));
      return {
        summary: r.summary ?? r.id ?? "(no summary)",
        severity: r.severity ?? null,
        trap: trap ? {id: trap.id, why: trap.trap} : null,
        kind: trap ? "flagged a correct behaviour" : "named no real defect",
      };
    });

  const recall = truth.defects.length ? found.length / truth.defects.length : null;
  // Reporting nothing is not precision. It is reported as null and scores 0.
  const precision = reported.length ? found.length / reported.length : null;

  return {
    reported: reported.length,
    truePositives: found.length,
    falseNegatives: missed.length,
    falsePositives: falsePositives.length,
    recall: recall === null ? null : +recall.toFixed(3),
    precision: precision === null ? null : +precision.toFixed(3),
    found,
    missed,
    falsePositiveDetail: falsePositives,
  };
}

/* ── 3 · triage accuracy ─────────────────────────────────────────────────── */

export const TRIAGE_CLASSES = ["product_defect", "valid_behaviour", "requirement_misunderstanding", "test_false_alarm", "inconclusive"];

/**
 * For every suspicious behaviour the run encountered, did it land in the right
 * bucket? Ground truth declares the correct class for each observable.
 */
export function scoreTriage(observations = [], truth) {
  const expected = new Map((truth.triage_expectations ?? []).map((t) => [t.observable, t]));
  const rows = [];

  for (const [observable, t] of expected) {
    const seen = observations.find((o) => norm(o.observable ?? o.id ?? "").includes(norm(observable)) || norm(observable).includes(norm(o.observable ?? o.id ?? "")));
    rows.push({
      observable,
      expected: t.correct_class,
      actual: seen?.classification ?? "not classified",
      correct: seen ? seen.classification === t.correct_class : false,
      why_it_matters: t.why_it_matters ?? null,
    });
  }

  const scored = rows.length;
  const correct = rows.filter((r) => r.correct).length;
  return {
    scored,
    correct,
    accuracy: scored ? +(correct / scored).toFixed(3) : null,
    misclassified: rows.filter((r) => !r.correct),
    rows,
  };
}

/* ── 4 · requirement interpretation ──────────────────────────────────────── */

/**
 * Did the architecture understand the requirement, or only react to a failing
 * test? Ground truth declares probes: things a correct reading implies, which a
 * test run alone would not surface.
 */
export function scoreInterpretation(interpretationText = "", ambiguities = [], truth) {
  const hay = norm([interpretationText, ...(ambiguities ?? []).map((a) => (typeof a === "string" ? a : a.question))].join(" "));
  const probes = truth.requirement_probes ?? [];
  const rows = probes.map((p) => ({
    probe: p.probe,
    hit: (p.accept_if_mentions ?? []).some((k) => hay.includes(norm(k))),
    weight: p.weight ?? 1,
    why_it_matters: p.why_it_matters ?? null,
  }));

  const total = rows.reduce((a, r) => a + r.weight, 0);
  const got = rows.filter((r) => r.hit).reduce((a, r) => a + r.weight, 0);
  return {
    probes: rows.length,
    hit: rows.filter((r) => r.hit).length,
    score: total ? +(got / total).toFixed(3) : null,
    stated: Boolean(norm(interpretationText)),
    missed: rows.filter((r) => !r.hit).map((r) => r.probe),
    rows,
  };
}

/* ── 5 · cross-agent challenge and self-correction ───────────────────────── */

/**
 * Count only CORRECT corrections.
 *
 * A later agent overturning an earlier one is worth nothing by itself: it might
 * simply be wrong in the other direction. Credit requires that the corrected
 * position matches ground truth. An overturn AWAY from the truth is counted
 * separately, as harm, because an architecture that argues itself out of a real
 * defect is worse than one that never argued.
 */
export function scoreSelfCorrection(corrections = [], truth) {
  const defectIds = new Set(truth.defects.map((d) => d.id));
  const trapIds = new Set(truth.correct_behaviours.map((t) => t.id));

  const rows = (corrections ?? []).map((c) => {
    const subject = c.subject_id ?? null;
    const toDefect = c.corrected_to === "defect";
    const isReal = subject && defectIds.has(subject);
    const isTrap = subject && trapIds.has(subject);

    // Correct in either direction: a trap rejected, or a real defect rescued.
    const correct = (toDefect && isReal) || (!toDefect && isTrap);
    const harmful = (toDefect && isTrap) || (!toDefect && isReal);

    return {
      from: c.from_phase ?? null,
      by: c.by_phase ?? null,
      subject,
      direction: toDefect ? "valid → defect" : "defect → valid",
      correct,
      harmful,
      reasoning: c.reasoning ?? null,
    };
  });

  const correct = rows.filter((r) => r.correct).length;
  const harmful = rows.filter((r) => r.harmful).length;
  const attempted = rows.length;

  return {
    attempted,
    correct,
    harmful,
    neutral: attempted - correct - harmful,
    // Net of harm, floored at zero: arguing yourself into a wrong answer must
    // not be rewarded merely for having argued.
    score: attempted ? +Math.max(0, (correct - harmful) / Math.max(attempted, truth.defects.length)).toFixed(3) : 0,
    rows,
  };
}

/* ── 6 · evidence quality ────────────────────────────────────────────────── */

export const EVIDENCE_PARTS = ["observed", "expected", "rule", "reproduction", "why_a_defect"];

/** A finding someone else has to re-investigate is half a finding. */
export function scoreEvidence(reported = []) {
  if (reported.length === 0) return {reports: 0, score: null, averageParts: null, rows: []};

  const rows = reported.map((r) => {
    const text = norm([r.summary, r.evidence, r.detail, r.expected, r.actual, r.observed].join(" "));
    const has = {
      observed: Boolean(norm(r.observed ?? r.actual)) || /observed|actual|returned|got /.test(text),
      expected: Boolean(norm(r.expected)) || /expected|should (be|return)/.test(text),
      rule: /requirement|spec|rule|br-|contract|documented/.test(text),
      reproduction: /(get|post|put|patch|delete)\s+\/|steps?:|reproduce|curl|then /.test(text),
      why_a_defect: /because|violates|contradicts|means that|matters/.test(text),
    };
    const parts = EVIDENCE_PARTS.filter((p) => has[p]).length;
    return {summary: r.summary ?? r.id, parts, has};
  });

  const avg = rows.reduce((a, r) => a + r.parts, 0) / rows.length;
  return {
    reports: rows.length,
    averageParts: +avg.toFixed(2),
    score: +(avg / EVIDENCE_PARTS.length).toFixed(3),
    complete: rows.filter((r) => r.parts === EVIDENCE_PARTS.length).length,
    rows,
  };
}

/* ── the whole scorecard for one architecture ────────────────────────────── */

export function scoreRun(run, truth) {
  const detection = scoreDetection(run.defects, truth);
  const triage = scoreTriage(run.observations, truth);
  const interpretation = scoreInterpretation(run.interpretation, run.ambiguities, truth);
  const selfCorrection = scoreSelfCorrection(run.corrections, truth);
  const evidence = scoreEvidence(run.defects);

  return {
    detection,
    triage,
    interpretation,
    selfCorrection,
    evidence,
    criteria: {
      precision: detection.precision ?? 0,
      recall: detection.recall ?? 0,
      triageAccuracy: triage.accuracy ?? 0,
      requirementInterpretation: interpretation.score ?? 0,
      evidenceQuality: evidence.score ?? 0,
      selfCorrection: selfCorrection.score ?? 0,
    },
    cost: {
      calls: run.usage?.calls ?? 0,
      agents: run.usage?.agents ?? 0,
      inputTokens: run.usage?.input ?? 0,
      outputTokens: run.usage?.output ?? 0,
      modelMs: run.usage?.ms ?? 0,
      wallMs: run.ms ?? 0,
    },
  };
}
