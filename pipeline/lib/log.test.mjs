import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { redact, registerSecret, clearSecrets } from "./log.mjs";

afterEach(() => clearSecrets());

describe("redaction", () => {
  test("removes a registered secret from a string", () => {
    registerSecret("super-secret-token-value");
    assert.equal(redact("Bearer super-secret-token-value"), "Bearer «redacted»");
  });

  test("removes it from anywhere in a nested structure", () => {
    registerSecret("super-secret-token-value");
    const out = redact({ a: [{ b: "x super-secret-token-value y" }], c: { d: "super-secret-token-value" } });
    assert.equal(out.a[0].b, "x «redacted» y");
    assert.equal(out.c.d, "«redacted»");
  });

  test("removes every occurrence, not just the first", () => {
    registerSecret("aaaaaaaa-token");
    assert.equal(redact("aaaaaaaa-token and aaaaaaaa-token"), "«redacted» and «redacted»");
  });

  test("redacts by key name too — a token read from a response was never registered", () => {
    const out = redact({ Authorization: "Bearer whatever", password: "hunter2", nested: { token: "abc" } });
    assert.equal(out.Authorization, "«redacted»");
    assert.equal(out.password, "«redacted»");
    assert.equal(out.nested.token, "«redacted»");
  });

  test("leaves innocent content alone", () => {
    registerSecret("super-secret-token-value");
    assert.equal(redact("nothing to hide here"), "nothing to hide here");
    assert.deepEqual(redact({ status: 201, id: "abc" }), { status: 201, id: "abc" });
  });

  test("ignores a value too short to be a credential, so ordinary text is not mangled", () => {
    registerSecret("ok");
    assert.equal(redact("this is ok and fine"), "this is ok and fine");
  });

  test("handles null, numbers and undefined without throwing", () => {
    assert.equal(redact(null), null);
    assert.equal(redact(42), 42);
    assert.equal(redact(undefined), undefined);
  });
});
