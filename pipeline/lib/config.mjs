// Configuration loading and validation.
//
// A pipeline that reads process.env directly fails deep inside a phase, hours in, with a
// confusing error. Everything is read and validated ONCE, here, before any phase runs, and a
// bad configuration is a clear message at startup rather than a stack trace at step 7.

import fs from "node:fs";
import path from "node:path";
import { registerSecret } from "./log.mjs";

/** Parse a .env file. No dependency, no shell semantics — KEY=value, # comments, blank lines. */
export function parseEnvFile(text) {
  const out = {};
  for (const raw of String(text ?? "").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key) out[key] = val;
  }
  return out;
}

const isUrl = (v) => {
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
};

// Every setting the pipeline can read, in one place. `required` is enforced at load time;
// anything optional states what happens when it is absent, so a partial config degrades
// predictably instead of silently.
export const SCHEMA = {
  APP_BASE_URL: { required: true, validate: isUrl, hint: "the running web app, e.g. http://localhost:3000" },
  API_BASE_URL: { required: true, validate: isUrl, hint: "the running API, e.g. http://localhost:3001" },
  TEST_USERNAME: { required: false, whenMissing: "contract probes that need auth are reported as skipped, never as passing" },
  TEST_PASSWORD: { required: false, whenMissing: "contract probes that need auth are reported as skipped, never as passing" },
  TRACKER_BASE_URL: { required: false, validate: isUrl, whenMissing: "the Tracker Publisher stays in dry-run and emits payloads only" },
  TRACKER_TOKEN: { required: false, whenMissing: "the Tracker Publisher stays in dry-run and emits payloads only" },
  PROTOTYPE_BASE_URL: { required: false, validate: isUrl, whenMissing: "the Design Parity track reports not-configured instead of comparing" },
  REQUEST_TIMEOUT_MS: { required: false, validate: (v) => Number.isFinite(+v) && +v > 0, coerce: Number, default: 10000 },
  PERF_ITERATIONS: { required: false, validate: (v) => Number.isInteger(+v) && +v > 0, coerce: Number, default: 20 },
  // Bounded, so a suite is neither serial-slow nor a load test of the app it measures.
  CONCURRENCY: { required: false, validate: (v) => Number.isInteger(+v) && +v > 0 && +v <= 64, coerce: Number, default: 4 },
  // Transport retries only — an answered request is never retried. See lib/retry.mjs.
  RETRY_ATTEMPTS: { required: false, validate: (v) => Number.isInteger(+v) && +v >= 1 && +v <= 10, coerce: Number, default: 3 },
};

export class ConfigError extends Error {
  constructor(problems) {
    super(
      "Configuration is not usable:\n" +
        problems.map((p) => `  · ${p}`).join("\n") +
        "\n\nCopy .env.example to .env and fill it in.",
    );
    this.name = "ConfigError";
    this.problems = problems;
  }
}

/**
 * Load, validate and freeze the configuration.
 * Throws ConfigError listing EVERY problem at once — fixing them one error per run is a waste
 * of the operator's time.
 */
export function loadConfig({ env = process.env, envFile = ".env", cwd = process.cwd() } = {}) {
  const filePath = path.resolve(cwd, envFile);
  const fromFile = fs.existsSync(filePath) ? parseEnvFile(fs.readFileSync(filePath, "utf8")) : {};
  const merged = { ...fromFile, ...env }; // a real environment variable beats the file

  const cfg = {};
  const problems = [];
  const degraded = [];

  for (const [key, rule] of Object.entries(SCHEMA)) {
    const raw = merged[key];
    const present = raw !== undefined && String(raw).trim() !== "";

    if (!present) {
      if (rule.required) {
        problems.push(`${key} is required — ${rule.hint ?? "no default"}`);
      } else {
        if (rule.default !== undefined) cfg[key] = rule.default;
        if (rule.whenMissing) degraded.push(`${key} not set — ${rule.whenMissing}`);
      }
      continue;
    }

    if (rule.validate && !rule.validate(raw)) {
      problems.push(`${key}="${raw}" is not valid — ${rule.hint ?? "check the format"}`);
      continue;
    }
    cfg[key] = rule.coerce ? rule.coerce(raw) : raw;
  }

  // Credentials only make sense as a pair; one without the other is a typo, not a choice.
  if (Boolean(cfg.TEST_USERNAME) !== Boolean(cfg.TEST_PASSWORD)) {
    problems.push("TEST_USERNAME and TEST_PASSWORD must be set together, or neither");
  }

  if (problems.length) throw new ConfigError(problems);

  // Register credentials before anything can log them. A QA tool holds the app's credentials by
  // design, and CI output is the classic way they escape.
  if (cfg.TEST_PASSWORD) registerSecret(cfg.TEST_PASSWORD);
  if (cfg.TRACKER_TOKEN) registerSecret(cfg.TRACKER_TOKEN);

  return Object.freeze({
    ...cfg,
    canAuthenticate: Boolean(cfg.TEST_USERNAME && cfg.TEST_PASSWORD),
    canPublish: Boolean(cfg.TRACKER_BASE_URL && cfg.TRACKER_TOKEN),
    degraded: Object.freeze(degraded),
  });
}
