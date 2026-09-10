import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, parseEnvFile, ConfigError } from "./config.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "aqa-cfg-"));
const ok = { APP_BASE_URL: "http://localhost:5200", API_BASE_URL: "http://localhost:8080" };

describe("parseEnvFile", () => {
  test("reads pairs, ignores comments and blanks", () => {
    assert.deepEqual(parseEnvFile("# c\nA=1\n\nB=two\n"), { A: "1", B: "two" });
  });
  test("strips surrounding quotes", () => {
    assert.deepEqual(parseEnvFile(`A="q"\nB='s'`), { A: "q", B: "s" });
  });
  test("keeps '=' inside a value", () => {
    assert.deepEqual(parseEnvFile("T=a=b=c"), { T: "a=b=c" });
  });
  test("survives junk without throwing", () => {
    assert.deepEqual(parseEnvFile("no-equals-here\n"), {});
    assert.deepEqual(parseEnvFile(null), {});
  });
});

describe("loadConfig", () => {
  test("loads a valid configuration and freezes it", () => {
    const cfg = loadConfig({ env: ok, cwd: tmp() });
    assert.equal(cfg.APP_BASE_URL, ok.APP_BASE_URL);
    assert.equal(Object.isFrozen(cfg), true);
  });

  test("applies documented defaults", () => {
    const cfg = loadConfig({ env: ok, cwd: tmp() });
    assert.equal(cfg.REQUEST_TIMEOUT_MS, 10000);
    assert.equal(cfg.PERF_ITERATIONS, 20);
  });

  test("reports EVERY problem at once, not one per run", () => {
    try {
      loadConfig({ env: { API_BASE_URL: "not-a-url" }, cwd: tmp() });
      assert.fail("should have thrown");
    } catch (e) {
      assert.ok(e instanceof ConfigError);
      assert.equal(e.problems.length, 2, "missing APP_BASE_URL and an invalid API_BASE_URL");
    }
  });

  test("rejects a non-http scheme rather than accepting a URL that cannot be fetched", () => {
    assert.throws(() => loadConfig({ env: { ...ok, API_BASE_URL: "ftp://x/y" }, cwd: tmp() }), ConfigError);
  });

  test("credentials must be set together, or neither", () => {
    assert.throws(() => loadConfig({ env: { ...ok, TEST_USERNAME: "u" }, cwd: tmp() }), /together/);
    const cfg = loadConfig({ env: { ...ok, TEST_USERNAME: "u", TEST_PASSWORD: "p" }, cwd: tmp() });
    assert.equal(cfg.canAuthenticate, true);
  });

  test("names what degrades when an optional setting is absent", () => {
    const cfg = loadConfig({ env: ok, cwd: tmp() });
    assert.equal(cfg.canPublish, false);
    assert.ok(cfg.degraded.some((d) => /TRACKER_BASE_URL/.test(d)));
    assert.ok(cfg.degraded.every((d) => d.includes("—")), "each note must say what happens, not only what is missing");
  });

  test("reads a .env file, and a real environment variable beats it", () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, ".env"), `APP_BASE_URL=http://from-file:1\nAPI_BASE_URL=http://from-file:2\n`);
    assert.equal(loadConfig({ env: {}, cwd: dir }).APP_BASE_URL, "http://from-file:1");
    assert.equal(loadConfig({ env: { APP_BASE_URL: "http://from-env:9" }, cwd: dir }).APP_BASE_URL, "http://from-env:9");
  });

  test("an empty string counts as absent, not as a value", () => {
    assert.throws(() => loadConfig({ env: { ...ok, APP_BASE_URL: "   " }, cwd: tmp() }), /APP_BASE_URL is required/);
  });

  test("a bad numeric setting is caught at load, not at the phase that uses it", () => {
    assert.throws(() => loadConfig({ env: { ...ok, REQUEST_TIMEOUT_MS: "soon" }, cwd: tmp() }), ConfigError);
  });
});
