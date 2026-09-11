// Pre-registered scoring weights.
//
// Written BEFORE any benchmark run, and not to be changed after seeing results.
// If a weight looks wrong once numbers exist, the honest move is to report both
// the pre-registered score and the revised one, labelled as a post-hoc revision.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THESE WEIGHTS
//
// The weighting is not neutral, and pretending otherwise would be dishonest. It
// encodes a claim about what a QA system is FOR, and that claim is arguable. So
// here it is, explicitly:
//
//   A QA system exists to tell a team the truth about their software.
//
// From that, three consequences:
//
// 1. PRECISION OUTRANKS RECALL.
//    A suite that cries wolf gets ignored, and an ignored suite has zero value
//    no matter how many real defects it also found. A team that stops trusting
//    its QA tooling stops reading it, and then the real defects it does find go
//    unread too. Missing a defect costs one defect; destroying trust costs every
//    future defect.
//
//    This weighting therefore penalises invented defects harder than missed
//    ones. That is a deliberate choice and a reasonable person could weight it
//    the other way for, say, safety-critical software where a miss is fatal and
//    a false alarm is merely expensive.
//
// 2. TRIAGE AND INTERPRETATION ARE WHERE JUDGEMENT LIVES.
//    Finding that a request returned 500 is mechanical: a script does it. Saying
//    whether that 500 is a product defect, a test defect, an environment problem
//    or the requirement being misread is the actual QA work, and it is what an
//    experienced engineer is paid for. These carry real weight.
//
// 3. EVIDENCE IS PART OF THE DELIVERABLE.
//    A defect report without the observed behaviour, the expected behaviour, the
//    rule it violates and a way to reproduce it is not a finding, it is a hint.
//    Someone else then has to redo the work.
//
// COST IS SCORED SEPARATELY, NOT BLENDED IN.
//    Folding cost into one number lets a large quality gain hide a 10x bill, or
//    lets a cheap system look good while being useless. Cost is reported beside
//    the quality score, and the conclusion has to argue the trade explicitly.
//
// SELF-CORRECTION IS THE HYPOTHESIS UNDER TEST.
//    It is weighted, but modestly. Weighting the thing you predicted would win
//    is how a benchmark gets rigged. Its real value is diagnostic: it is the one
//    metric a single agent structurally CANNOT score on, so if the split earns
//    its cost anywhere, the evidence should show up here and in triage.
// ─────────────────────────────────────────────────────────────────────────────

export const WEIGHTS = Object.freeze({
  precision: 0.25,              // inventing defects destroys trust in everything else
  recall: 0.20,                 // missing real defects is the other half of the job
  triageAccuracy: 0.20,         // the judgement a script cannot make
  requirementInterpretation: 0.15, // reacting to a failing test is not understanding
  evidenceQuality: 0.10,        // a finding someone else must redo is half a finding
  selfCorrection: 0.10,         // the hypothesis, weighted modestly on purpose
});

export const WEIGHT_RATIONALE = Object.freeze({
  precision:
    "Highest weight. A suite that reports defects that are not defects gets ignored, and an ignored suite returns nothing on anything else it finds. Missing one defect costs one defect; losing trust costs every future finding.",
  recall:
    "Close behind precision. A system that never reports anything is trivially precise and useless.",
  triageAccuracy:
    "Detecting a 500 is mechanical. Deciding whether it is a product defect, a test defect, an environment problem or a misread requirement is the QA work itself.",
  requirementInterpretation:
    "A system that only reacts to failing tests will find what the tests happened to cover. Understanding the requirement is what surfaces the case nobody wrote.",
  evidenceQuality:
    "A report lacking observed behaviour, expected behaviour, the rule, and reproduction makes a developer redo the investigation.",
  selfCorrection:
    "Deliberately modest. It is the metric this architecture was predicted to win, and weighting your own prediction heavily is how a benchmark gets rigged. It is kept because a single agent structurally cannot score on it, which makes it diagnostic.",
});

export const COST_POLICY = Object.freeze({
  blended: false,
  rule:
    "Cost is reported beside the quality score, never inside it. A quality gain bought at many times the price must be stated as a trade, not presented as an unqualified win.",
  flagIfCostRatioAbove: 3,
  flagIfQualityGainBelow: 0.05,
  verdictRule:
    "If the twelve-agent quality score exceeds the baseline by less than flagIfQualityGainBelow while costing more than flagIfCostRatioAbove times as much, the result is reported as 'not worth the cost' regardless of which side has the higher quality number.",
});

/** Combine per-criterion scores (each 0-1) into one transparent number. */
export function overall(scores) {
  let total = 0;
  const contributions = {};
  for (const [k, w] of Object.entries(WEIGHTS)) {
    const v = typeof scores[k] === "number" && Number.isFinite(scores[k]) ? scores[k] : 0;
    contributions[k] = +(v * w).toFixed(4);
    total += v * w;
  }
  return {score: +total.toFixed(4), contributions, weights: WEIGHTS};
}

/** Apply the cost policy to two overall scores and their costs. */
export function verdict(single, twelve) {
  const gain = +(twelve.score - single.score).toFixed(4);
  const ratio = single.cost > 0 ? +(twelve.cost / single.cost).toFixed(2) : null;
  const expensive = ratio !== null && ratio > COST_POLICY.flagIfCostRatioAbove;
  const marginal = Math.abs(gain) < COST_POLICY.flagIfQualityGainBelow;

  let call;
  if (gain <= 0) call = "the twelve-agent architecture did not beat the baseline on quality";
  else if (expensive && marginal) call = "not worth the cost: a marginal quality gain at a large cost multiple";
  else if (expensive) call = `a real quality gain, bought at ${ratio}x the cost — a trade to argue, not a clean win`;
  else call = "the twelve-agent architecture won on quality without an unreasonable cost penalty";

  return {qualityGain: gain, costRatio: ratio, flaggedExpensive: expensive, flaggedMarginal: marginal, call};
}
