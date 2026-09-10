import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { deriveType, explainType, applyTags, validateTags, TYPE_RULES } from "./tags.mjs";

describe("deriveType · inflection", () => {
  // The regression that started this: the same intent tagged differently depending on the
  // verb form, because the rule matched \bdelete\b and "deleting" is not that word.
  test("every inflection of an action produces the same type", () => {
    for (const form of ["delete", "deletes", "deleted", "deleting"]) {
      assert.equal(deriveType(`I ${form} an item from the list`), "lifecycle", `form: ${form}`);
    }
    for (const form of ["remove", "removes", "removed", "removing"]) {
      assert.equal(deriveType(`I ${form} a saved item`), "lifecycle", `form: ${form}`);
    }
  });

  test("TAG-01 · a guard reads the same however the verb is inflected", () => {
    const a = deriveType("Cancelling the delete confirmation keeps the item");
    const b = deriveType("Cancel before deleting an item");
    const c = deriveType("Cancel before delete of an item");
    assert.equal(a, "guard");
    assert.equal(b, "guard");
    assert.equal(c, "guard");
  });
});

describe("deriveType · precedence", () => {
  test("guard beats lifecycle when an action is aborted rather than completed", () => {
    // Both signals are present. The test is about the abort, so it is a guard.
    assert.equal(deriveType("Cancelling the delete confirmation keeps the item"), "guard");
  });

  test("lifecycle wins when the state change actually completes", () => {
    assert.equal(deriveType("Delete an item from the list"), "lifecycle");
  });

  test("negative beats everything else", () => {
    assert.equal(deriveType("Deleting another user's item is rejected"), "negative");
    assert.equal(deriveType("Saving an out-of-stock item is blocked"), "negative");
  });

  test("edge beats lifecycle for a boundary value", () => {
    assert.equal(deriveType("Deleting the last remaining item leaves an empty list"), "edge");
  });

  test("happy is the fallback, not a match", () => {
    const e = explainType("Save an item by pasting a link");
    assert.equal(e.type, "happy");
    assert.equal(e.on, null);
  });

  test("precedence is declared by rule order, and that order is the contract", () => {
    assert.deepEqual(TYPE_RULES.map((r) => r[1]), ["negative", "guard", "edge", "lifecycle"]);
  });
});

describe("explainType · auditability", () => {
  test("reports what it matched on and what else matched", () => {
    const e = explainType("Cancelling the delete confirmation keeps the item");
    assert.equal(e.type, "guard");
    assert.match(e.on, /Cancelling/i);
    assert.ok(e.why.length > 0);
    assert.deepEqual(e.alsoMatched, ["lifecycle"]); // the signal it deliberately outranked
  });

  test("a surprising tag can always be explained", () => {
    for (const s of ["Delete an item", "An empty URL is rejected", "Cancel the dialog", "The maximum length is enforced"]) {
      const e = explainType(s);
      assert.ok(e.why, `no reason given for: ${s}`);
    }
  });
});

describe("applyTags", () => {
  const feature = [
    "Feature: Save and delete items",
    "",
    "  Scenario: EX-101 Save an item by pasting a link",
    "    When I paste a link into the save box",
    "    Then my list shows 1 item",
    "",
    "  Scenario: EX-103 Cancelling the delete confirmation keeps the item",
    "    When I choose delete on that item",
    "    And I dismiss the confirmation",
    "    Then my list still shows 1 item",
  ].join("\n");

  test("stamps @area once at feature level and @type per scenario", () => {
    const out = applyTags(feature, "items");
    assert.equal((out.match(/@area:items/g) || []).length, 1);
    assert.match(out, /@type:happy\n\s*Scenario: EX-101/);
    assert.match(out, /@type:guard\n\s*Scenario: EX-103/);
  });

  test("reads the steps, not only the title", () => {
    // The title alone says nothing; "dismiss the confirmation" is in the steps.
    const s = "Feature: f\n\n  Scenario: EX-999 An item\n    When I choose delete\n    And I dismiss the confirmation\n";
    assert.match(applyTags(s, "items"), /@type:guard/);
  });

  test("is idempotent — running it twice changes nothing", () => {
    const once = applyTags(feature, "items");
    assert.equal(applyTags(once, "items"), once);
  });

  test("never overwrites a tag a human wrote", () => {
    const manual = "@area:items\nFeature: f\n\n  @type:edge\n  Scenario: Delete an item\n    When I delete it\n";
    const out = applyTags(manual, "items");
    assert.match(out, /@type:edge/);
    assert.doesNotMatch(out, /@type:lifecycle/);
  });

  test("preserves indentation", () => {
    const out = applyTags(feature, "items");
    for (const line of out.split("\n")) {
      if (/@type:/.test(line)) assert.match(line, /^ {2}@type:/, `bad indent: "${line}"`);
    }
  });

  test("tags a Scenario Outline too", () => {
    const s = "Feature: f\n\n  Scenario Outline: Deleting <thing>\n    When I delete <thing>\n";
    assert.match(applyTags(s, "items"), /@type:lifecycle/);
  });

  test("refuses to stamp without an area rather than writing @area:undefined", () => {
    assert.throws(() => applyTags(feature, ""), /area is required/);
    assert.throws(() => applyTags(feature, undefined), /area is required/);
  });
});

describe("validateTags", () => {
  test("passes a fully tagged feature", () => {
    assert.deepEqual(validateTags(applyTags("Feature: f\n\n  Scenario: Add a thing\n    When I add\n", "items")), []);
  });

  test("reports the untagged scenario and which tag is missing", () => {
    const s = "@area:items\nFeature: f\n\n  Scenario: Add a thing\n    When I add\n";
    const missing = validateTags(s);
    assert.equal(missing.length, 1);
    assert.match(missing[0].scenario, /Add a thing/);
    assert.deepEqual(missing[0].missing, ["@type"]);
  });

  test("a feature-level @area covers every scenario in it", () => {
    const s = "@area:items\nFeature: f\n\n  @type:happy\n  Scenario: One\n    When x\n\n  @type:edge\n  Scenario: Two\n    When y\n";
    assert.deepEqual(validateTags(s), []);
  });

  test("a blank line between tags and Scenario is still legal Gherkin", () => {
    const s = "@area:items\nFeature: f\n\n  @type:happy\n\n  Scenario: One\n    When x\n";
    assert.deepEqual(validateTags(s), []);
  });

  test("handles empty and malformed input without throwing", () => {
    assert.deepEqual(validateTags(""), []);
    assert.deepEqual(validateTags(null), []);
    assert.deepEqual(validateTags("not gherkin at all"), []);
  });
});
