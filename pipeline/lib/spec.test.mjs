import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseSpec, SpecError } from "./spec.mjs";

const base = () => ({
  id: "spec:demo",
  area: "items",
  behaviours: [{ id: "D-1", title: "Save an item", feature: "add item", when: ["I save"], then: "it is saved" }],
});

describe("parseSpec", () => {
  test("accepts a minimal valid spec and freezes it", () => {
    const s = parseSpec(base());
    assert.equal(s.id, "spec:demo");
    assert.equal(Object.isFrozen(s), true);
    assert.equal(Object.isFrozen(s.behaviours), true);
  });

  test("infers the layer: a contract means API, otherwise UI", () => {
    const s = parseSpec({
      ...base(),
      behaviours: [
        base().behaviours[0],
        { id: "D-2", title: "x", feature: "f", when: ["a"], then: "b", contract: { method: "get", path: "/x", expect: { status: 200 } } },
      ],
    });
    assert.equal(s.behaviours[0].layer, "UI");
    assert.equal(s.behaviours[1].layer, "API");
    assert.equal(s.behaviours[1].contract.method, "GET", "method is normalised to upper case");
  });

  test("collects every problem rather than throwing on the first", () => {
    try {
      parseSpec({ behaviours: [{ id: "D-1" }] });
      assert.fail("should have thrown");
    } catch (e) {
      assert.ok(e instanceof SpecError);
      assert.ok(e.problems.length >= 4, `expected several problems, got ${e.problems.length}`);
    }
  });

  test("rejects a duplicate behaviour id — two cases with one key are untraceable", () => {
    const s = base();
    s.behaviours = [s.behaviours[0], { ...s.behaviours[0] }];
    assert.throws(() => parseSpec(s), /duplicated/);
  });

  test("a contract must say what a correct response looks like", () => {
    const s = base();
    s.behaviours[0].contract = { method: "GET", path: "/x" };
    assert.throws(() => parseSpec(s), /expect is required/);
  });

  test("rejects an unusable contract path or method", () => {
    const bad = (contract) => {
      const s = base();
      s.behaviours[0].contract = contract;
      return () => parseSpec(s);
    };
    assert.throws(bad({ method: "GET", path: "x", expect: { status: 200 } }), /must start with/);
    assert.throws(bad({ method: "FETCH", path: "/x", expect: { status: 200 } }), /method must be one of/);
    assert.throws(bad({ method: "GET", path: "/x", expect: { status: 99 } }), /must be an HTTP status/);
  });

  test("accepts a list of acceptable statuses", () => {
    const s = base();
    s.behaviours[0].contract = { method: "DELETE", path: "/x", expect: { status: [200, 204] } };
    assert.deepEqual(parseSpec(s).behaviours[0].contract.expect.status, [200, 204]);
  });

  test("auth needs both a path and the field the token comes back in", () => {
    const s = base();
    s.auth = { path: "/login" };
    assert.throws(() => parseSpec(s), /tokenField is required/);
  });

  test("a behaviour with neither steps nor a contract is refused — nothing could verify it", () => {
    const s = base();
    s.behaviours = [{ id: "D-9", title: "t", feature: "f", then: "something" }];
    assert.throws(() => parseSpec(s), SpecError);
  });
});
