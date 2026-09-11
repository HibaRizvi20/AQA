import {test, describe} from "node:test";
import assert from "node:assert/strict";
import {collectPipeline, collectSingle} from "./collect.mjs";

// Both architectures must reduce to the same shape before scoring, or the
// benchmark measures reporting style rather than QA quality.

describe("collecting the pipeline", () => {
  test("only what still stands as a defect after triage is counted", () => {
    const out = collectPipeline({
      "06-self-heal": {
        triaged: [
          {id: "C1", classification: "product_defect", detail: "500 on re-add"},
          {id: "C2", classification: "valid_behaviour", detail: "409 on duplicate is correct"},
          {id: "C3", classification: "test_false_alarm", detail: "stale selector"},
          {id: "C4", classification: "requirement_misunderstanding", detail: "the case misread the rule"},
        ],
      },
    });
    assert.deepEqual(out.defects.map((d) => d.id), ["C1"]);
    assert.equal(out.observations.length, 4, "every judgement is still gradeable as triage");
  });

  test("a behaviour a later phase overturned to valid is NOT reported as a defect", () => {
    // This is the behaviour the whole benchmark exists to detect. Collecting it
    // anyway would erase the difference between an architecture that rejects a
    // false alarm and one that cannot.
    const out = collectPipeline({
      "06-self-heal": {triaged: [{id: "C1", classification: "product_defect", detail: "bare host accepted"}]},
      "08-review": {corrections: [{subject_id: "C1", from_phase: "06-self-heal", corrected_to: "valid", reasoning: "a bare host declares no scheme"}]},
    });
    assert.deepEqual(out.defects, [], "the reviewer rejected it, so it is not a reported defect");
    assert.equal(out.corrections.length, 1);
    assert.equal(out.corrections[0].by_phase, "08-review");
  });

  test("something a later phase RAISED to a defect is reported", () => {
    const out = collectPipeline({
      "06-self-heal": {triaged: [{id: "C9", classification: "valid_behaviour", detail: "looked fine"}]},
      "08-review": {corrections: [{subject_id: "C9", corrected_to: "defect", reasoning: "the requirement forbids this"}]},
    });
    assert.equal(out.defects.length, 1);
    assert.equal(out.defects[0].id, "C9");
  });

  test("corrections from triage and review are both collected, and attributed", () => {
    const out = collectPipeline({
      "06-self-heal": {triaged: [], corrections: [{subject_id: "A", corrected_to: "valid", reasoning: "x"}]},
      "08-review": {corrections: [{subject_id: "B", corrected_to: "defect", reasoning: "y"}]},
    });
    assert.deepEqual(out.corrections.map((c) => c.by_phase), ["06-self-heal", "08-review"]);
  });

  test("a blocking pre-flight finding counts, since it precedes any test", () => {
    const out = collectPipeline({
      "00-preflight": {findings: [{id: "P1", severity: "blocking", detail: "the control does not exist"}, {id: "P2", severity: "info", detail: "noted"}]},
    });
    assert.deepEqual(out.defects.map((d) => d.id), ["P1"]);
  });

  test("the five evidence parts survive collection when the agent supplied them", () => {
    const out = collectPipeline({
      "06-self-heal": {triaged: [{
        id: "C1", classification: "product_defect",
        observed: "HTTP 500", expected: "HTTP 201", rule: "BR-12",
        reproduction: "POST then DELETE then POST", why_a_defect: "because ordinary behaviour errors",
      }]},
    });
    const d = out.defects[0];
    for (const k of ["observed", "expected", "rule", "reproduction", "why_a_defect"]) {
      assert.ok(d[k], `${k} was dropped in collection`);
    }
  });

  test("an empty run collects to empty rather than throwing", () => {
    const out = collectPipeline({});
    assert.deepEqual(out.defects, []);
    assert.deepEqual(out.corrections, []);
    assert.equal(out.interpretation, "");
  });
});

describe("collecting the single agent", () => {
  test("its flat list reduces to the same shape", () => {
    const out = collectSingle({
      interpretation: "the requirement means X",
      defects: [{summary: "500 on re-add", evidence: "POST after DELETE"}],
      ambiguities: ["is a duplicate an error?"],
    });
    assert.equal(out.defects.length, 1);
    assert.equal(out.defects[0].id, "SA-1", "an unlabelled report still gets a stable id");
    assert.equal(out.interpretation, "the requirement means X");
  });

  test("corrections are empty by construction, and that is the finding", () => {
    // One pass has no later phase to overturn an earlier one. The structural
    // zero is a fact about the architecture, not a gap in collection.
    const out = collectSingle({defects: [{summary: "x"}]});
    assert.deepEqual(out.corrections, []);
  });

  test("a malformed report does not crash the collection", () => {
    const out = collectSingle({defects: [null, "just a string", {summary: "real one"}]});
    assert.equal(out.defects.length, 3);
    assert.ok(out.defects.every((d) => typeof d.summary === "string"));
  });
});
