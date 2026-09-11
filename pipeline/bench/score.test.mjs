import {test, describe} from "node:test";
import assert from "node:assert/strict";
import {
  scoreDetection, scoreTriage, scoreInterpretation, scoreSelfCorrection, scoreEvidence, scoreRun,
} from "./score.mjs";
import {overall, verdict, WEIGHTS} from "./weights.mjs";

// The scorer is the instrument. If it is wrong, every number downstream is wrong
// and confidently so, which is worse than having no numbers. These fixtures are
// built so the right answer is known by construction.

const truth = {
  defects: [
    {id: "D1", severity: "high", summary: "re-add after delete returns 500",
     accept_if_mentions: ["re-add", "deleted", "500"], require_signals: 2},
    {id: "D2", severity: "medium", summary: "ftp scheme rewritten",
     accept_if_mentions: ["ftp", "scheme", "rewritten"], require_signals: 2},
  ],
  correct_behaviours: [
    {id: "T1", summary: "bare host accepted", trap: "correct by design",
     recognise_if_mentions: ["bare host", "without a scheme"]},
  ],
  triage_expectations: [
    {observable: "500 on re-add", correct_class: "product_defect"},
    {observable: "409 on duplicate", correct_class: "valid_behaviour"},
  ],
  requirement_probes: [
    {probe: "understands that delete is a soft delete", accept_if_mentions: ["soft delete", "tombstone"], weight: 2},
    {probe: "notices the duplicate rule", accept_if_mentions: ["duplicate", "already saved"], weight: 1},
  ],
};

describe("detection · credit is earned, not assumed", () => {
  test("a report naming two signals of a real defect is credited", () => {
    const r = scoreDetection([{summary: "re-add of a deleted link returns 500"}], truth);
    assert.equal(r.truePositives, 1);
    assert.equal(r.falsePositives, 0);
    assert.equal(r.falseNegatives, 1); // D2 was still missed
  });

  test("a single incidental word does not claim a defect", () => {
    // "500" alone could appear in any report. One signal is not a match.
    const r = scoreDetection([{summary: "something returned 500 somewhere"}], truth);
    assert.equal(r.truePositives, 0);
    assert.equal(r.falsePositives, 1);
  });

  test("flagging a correct behaviour is a false positive, and the trap is named", () => {
    const r = scoreDetection([{summary: "bug: a bare host is accepted without a scheme"}], truth);
    assert.equal(r.truePositives, 0);
    assert.equal(r.falsePositives, 1);
    assert.equal(r.falsePositiveDetail[0].trap.id, "T1");
    assert.match(r.falsePositiveDetail[0].kind, /correct behaviour/);
  });

  test("a vague report that names nothing real is still a false positive", () => {
    // The bug this replaces: an earlier version returned an object from a filter
    // predicate, so every non-match counted regardless. That made precision
    // meaningless. Here the classification is explicit.
    const r = scoreDetection([{summary: "the app feels unreliable"}], truth);
    assert.equal(r.falsePositives, 1);
    assert.equal(r.falsePositiveDetail[0].trap, null);
    assert.match(r.falsePositiveDetail[0].kind, /named no real defect/);
  });

  test("reporting nothing is not precision", () => {
    const r = scoreDetection([], truth);
    assert.equal(r.recall, 0);
    assert.equal(r.precision, null, "silence must not score a flattering 1");
    assert.equal(r.falseNegatives, 2);
  });

  test("a perfect run", () => {
    const r = scoreDetection(
      [{summary: "re-add of a deleted item returns 500"}, {summary: "an ftp scheme is rewritten not refused"}],
      truth,
    );
    assert.equal(r.recall, 1);
    assert.equal(r.precision, 1);
  });

  test("one real plus one invented gives precision 0.5", () => {
    const r = scoreDetection(
      [{summary: "re-add of a deleted item returns 500"}, {summary: "bug: bare host accepted without a scheme"}],
      truth,
    );
    assert.equal(r.truePositives, 1);
    assert.equal(r.falsePositives, 1);
    assert.equal(r.precision, 0.5);
  });

  test("the same defect reported twice is not credited twice", () => {
    const r = scoreDetection(
      [{summary: "re-add deleted 500"}, {summary: "re-add of deleted returns 500 again"}],
      truth,
    );
    assert.equal(r.truePositives, 1);
    assert.equal(r.falsePositives, 1, "the duplicate report is not a second find");
  });
});

describe("triage · the judgement a script cannot make", () => {
  test("correct classification scores", () => {
    const r = scoreTriage(
      [{observable: "500 on re-add", classification: "product_defect"},
       {observable: "409 on duplicate", classification: "valid_behaviour"}],
      truth,
    );
    assert.equal(r.accuracy, 1);
  });

  test("calling a correct behaviour a defect is a misclassification", () => {
    const r = scoreTriage(
      [{observable: "500 on re-add", classification: "product_defect"},
       {observable: "409 on duplicate", classification: "product_defect"}],
      truth,
    );
    assert.equal(r.correct, 1);
    assert.equal(r.accuracy, 0.5);
    assert.equal(r.misclassified[0].expected, "valid_behaviour");
  });

  test("not classifying at all counts against, it is not neutral", () => {
    const r = scoreTriage([], truth);
    assert.equal(r.accuracy, 0);
    assert.equal(r.rows.every((x) => x.actual === "not classified"), true);
  });
});

describe("requirement interpretation · understanding, not reacting", () => {
  test("weighted probes", () => {
    const r = scoreInterpretation("delete is a soft delete, the row is tombstoned", [], truth);
    assert.equal(r.hit, 1);
    assert.equal(r.score, +(2 / 3).toFixed(3), "the heavier probe is worth more");
  });

  test("an ambiguity raised counts as understanding", () => {
    const r = scoreInterpretation("", [{question: "is a duplicate rejected or ignored?"}], truth);
    assert.ok(r.score > 0);
  });

  test("saying nothing scores zero and is marked unstated", () => {
    const r = scoreInterpretation("", [], truth);
    assert.equal(r.score, 0);
    assert.equal(r.stated, false);
  });
});

describe("self-correction · only correct corrections count", () => {
  test("overturning a trap is credited", () => {
    const r = scoreSelfCorrection([{from_phase: "01-scope", by_phase: "08-review", subject_id: "T1", corrected_to: "valid"}], truth);
    assert.equal(r.correct, 1);
    assert.equal(r.harmful, 0);
  });

  test("rescuing a real defect a earlier agent dismissed is credited", () => {
    const r = scoreSelfCorrection([{subject_id: "D1", corrected_to: "defect"}], truth);
    assert.equal(r.correct, 1);
  });

  test("arguing a REAL defect away is harm, not success", () => {
    // The failure mode this metric exists to catch: an architecture that talks
    // itself out of a true finding is worse than one that never argued.
    const r = scoreSelfCorrection([{subject_id: "D1", corrected_to: "valid"}], truth);
    assert.equal(r.correct, 0);
    assert.equal(r.harmful, 1);
    assert.equal(r.score, 0, "harm must not be rewarded for having disagreed");
  });

  test("promoting a correct behaviour to a defect is harm", () => {
    const r = scoreSelfCorrection([{subject_id: "T1", corrected_to: "defect"}], truth);
    assert.equal(r.harmful, 1);
  });

  test("disagreement alone is not success", () => {
    const mixed = scoreSelfCorrection(
      [{subject_id: "T1", corrected_to: "valid"}, {subject_id: "D1", corrected_to: "valid"}],
      truth,
    );
    assert.equal(mixed.correct, 1);
    assert.equal(mixed.harmful, 1);
    assert.equal(mixed.score, 0, "one right and one wrong nets to nothing");
  });

  test("no corrections scores zero, which is what a single agent gets", () => {
    assert.equal(scoreSelfCorrection([], truth).score, 0);
  });
});

describe("evidence quality", () => {
  test("a complete report scores full marks", () => {
    const r = scoreEvidence([{
      summary: "re-add returns 500",
      observed: "HTTP 500",
      expected: "HTTP 201",
      evidence: "POST /v1/items after DELETE /v1/items/{id}; the requirement says a deleted link can be saved again, so this violates it because the tombstone blocks the insert",
    }]);
    assert.equal(r.score, 1);
    assert.equal(r.complete, 1);
  });

  test("a bare assertion scores poorly", () => {
    const r = scoreEvidence([{summary: "delete is broken"}]);
    assert.ok(r.score < 0.5, `expected a low score, got ${r.score}`);
  });

  test("no reports gives null rather than a misleading zero", () => {
    assert.equal(scoreEvidence([]).score, null);
  });
});

describe("the weighted scorecard", () => {
  test("weights are pre-registered and sum to one", () => {
    const sum = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
    assert.equal(+sum.toFixed(6), 1, "an unnormalised weighting hides where the score came from");
  });

  test("precision outranks recall, as declared", () => {
    assert.ok(WEIGHTS.precision > WEIGHTS.recall);
  });

  test("the hypothesis is not the heaviest weight", () => {
    // Weighting the metric you predicted would win is how a benchmark gets rigged.
    const heaviest = Object.entries(WEIGHTS).sort((a, b) => b[1] - a[1])[0][0];
    assert.notEqual(heaviest, "selfCorrection");
  });

  test("contributions are transparent and add to the total", () => {
    const r = overall({precision: 1, recall: 1, triageAccuracy: 1, requirementInterpretation: 1, evidenceQuality: 1, selfCorrection: 1});
    assert.equal(r.score, 1);
    assert.equal(+Object.values(r.contributions).reduce((a, b) => a + b, 0).toFixed(4), 1);
  });

  test("a missing criterion scores zero rather than being skipped", () => {
    const r = overall({precision: 1});
    assert.equal(r.score, WEIGHTS.precision);
  });
});

describe("the cost policy", () => {
  test("a marginal gain at a large cost multiple is called out", () => {
    const v = verdict({score: 0.70, cost: 10}, {score: 0.72, cost: 90});
    assert.equal(v.flaggedExpensive, true);
    assert.equal(v.flaggedMarginal, true);
    assert.match(v.call, /not worth the cost/);
  });

  test("a real gain at a large multiple is a trade, not a clean win", () => {
    const v = verdict({score: 0.55, cost: 10}, {score: 0.80, cost: 60});
    assert.match(v.call, /trade/);
  });

  test("losing on quality is said plainly", () => {
    const v = verdict({score: 0.80, cost: 10}, {score: 0.70, cost: 60});
    assert.match(v.call, /did not beat the baseline/);
  });

  test("a clean win is only claimed when cost is reasonable", () => {
    const v = verdict({score: 0.60, cost: 10}, {score: 0.80, cost: 22});
    assert.match(v.call, /without an unreasonable cost penalty/);
  });
});

describe("scoreRun · a single agent cannot score on self-correction", () => {
  test("the structural zero is visible rather than hidden", () => {
    const s = scoreRun({defects: [], usage: {}, corrections: []}, truth);
    assert.equal(s.criteria.selfCorrection, 0);
    assert.equal(s.criteria.precision, 0, "no reports means precision null, scored as 0");
  });
});
