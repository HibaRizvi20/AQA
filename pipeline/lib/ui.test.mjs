import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { validateUiSteps, loadDriver, runUiBehaviour } from "./ui.mjs";

describe("validateUiSteps", () => {
  const problems = () => [];

  test("accepts the documented vocabulary", () => {
    const p = problems();
    validateUiSteps([{ goto: "/x" }, { click: { selector: "#a" } }, { expectText: { selector: "#b", toContainText: "hi" } }], "b[0]", p);
    assert.deepEqual(p, []);
  });

  test("refuses an unknown action rather than ignoring it", () => {
    const p = problems();
    validateUiSteps([{ scroll: "#x" }], "b[0]", p);
    assert.match(p[0], /"scroll" is not a known action/);
  });

  test("a step must name exactly one action", () => {
    const p = problems();
    validateUiSteps([{ click: "#a", fill: "#b" }], "b[0]", p);
    assert.match(p[0], /exactly one action/);
  });

  test("an empty step list is a spec error, not an empty test", () => {
    const p = problems();
    validateUiSteps([], "b[0]", p);
    assert.match(p[0], /non-empty/);
  });

  test("absent ui.steps is fine — a behaviour may be API-only", () => {
    const p = problems();
    validateUiSteps(undefined, "b[0]", p);
    assert.deepEqual(p, []);
  });
});

describe("loadDriver", () => {
  test("absence of a browser is a supported state with a reason, not a throw", async () => {
    const d = await loadDriver();
    if (d.available) {
      assert.equal(typeof d.chromium.launch, "function");
    } else {
      assert.match(d.reason, /playwright/i);
      assert.ok(d.reason.includes("npm i"), "the reason must tell the operator how to fix it");
    }
  });
});

describe("runUiBehaviour", () => {
  test("a behaviour with no steps is skipped with a reason", async () => {
    const r = await runUiBehaviour({ id: "X" }, {});
    assert.equal(r.verdict, "skipped");
    assert.match(r.reason, /no ui.steps/);
  });

  // The browser-backed assertions live in pipeline.test.mjs, which drives a real page. Here we
  // only prove the module degrades correctly, so this file stays runnable with no browser.
  test("is importable and callable without a browser present", async () => {
    const r = await runUiBehaviour({ id: "X", ui: { steps: [{ goto: "/" }] } }, { browser: null }).catch((e) => e);
    assert.ok(r instanceof Error || r.verdict, "it must not hang or crash the process");
  });
});
