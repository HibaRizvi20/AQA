// The spec format — the input the whole pipeline runs on.
//
// This file is what makes AQA runnable without a model. A spec states behaviours in a structured
// form: what the user does, what should happen, and (optionally) the API contract that backs it.
// Every phase downstream is then a deterministic transform over this object.
//
// An LLM is useful for turning a paragraph of prose INTO this shape. It is not required to run
// the pipeline, and nothing downstream calls one.

const ID = /^[A-Za-z][A-Za-z0-9_-]*(?::[A-Za-z0-9_.-]+)*$/;
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

export class SpecError extends Error {
  constructor(problems) {
    super("Spec is not usable:\n" + problems.map((p) => `  · ${p}`).join("\n"));
    this.name = "SpecError";
    this.problems = problems;
  }
}

const isStr = (v) => typeof v === "string" && v.trim() !== "";
const isArr = (v) => Array.isArray(v) && v.length > 0;

function validateContract(c, where, problems) {
  if (c === undefined) return;
  if (typeof c !== "object" || c === null) return problems.push(`${where}.contract must be an object`);
  if (!isStr(c.method) || !METHODS.has(c.method.toUpperCase())) {
    problems.push(`${where}.contract.method must be one of ${[...METHODS].join(", ")}`);
  }
  if (!isStr(c.path) || !c.path.startsWith("/")) problems.push(`${where}.contract.path must start with "/"`);
  if (typeof c.expect !== "object" || c.expect === null) {
    problems.push(`${where}.contract.expect is required — state what a correct response looks like`);
    return;
  }
  const { status, hasFields, bodyMatches } = c.expect;
  const statuses = Array.isArray(status) ? status : [status];
  if (!statuses.every((s) => Number.isInteger(s) && s >= 100 && s < 600)) {
    problems.push(`${where}.contract.expect.status must be an HTTP status, or an array of them`);
  }
  if (hasFields !== undefined && !Array.isArray(hasFields)) {
    problems.push(`${where}.contract.expect.hasFields must be an array of field paths`);
  }
  if (bodyMatches !== undefined && typeof bodyMatches !== "object") {
    problems.push(`${where}.contract.expect.bodyMatches must be an object of field → expected value`);
  }
}

/**
 * Validate a parsed spec object and return a normalised, frozen copy.
 * Collects every problem rather than throwing on the first, so a spec can be fixed in one pass.
 */
export function parseSpec(input) {
  const problems = [];
  const s = input ?? {};

  if (!isStr(s.id) || !ID.test(s.id)) problems.push('id is required, e.g. "spec:resource-add-delete"');
  if (!isStr(s.area)) problems.push('area is required — the product feature, e.g. "library"');
  if (!isArr(s.behaviours)) problems.push("behaviours must be a non-empty array");

  if (s.auth !== undefined) {
    const a = s.auth;
    if (!isStr(a?.path)) problems.push("auth.path is required when auth is present");
    if (!isStr(a?.tokenField)) problems.push('auth.tokenField is required, e.g. "accessToken"');
  }

  const seen = new Set();
  for (const [i, b] of (Array.isArray(s.behaviours) ? s.behaviours : []).entries()) {
    const where = `behaviours[${i}]`;
    if (!isStr(b?.id)) problems.push(`${where}.id is required — the tracker key or case id`);
    else if (seen.has(b.id)) problems.push(`${where}.id "${b.id}" is duplicated`);
    else seen.add(b.id);

    if (!isStr(b?.title)) problems.push(`${where}.title is required`);
    if (!isStr(b?.feature)) problems.push(`${where}.feature is required — which product feature this belongs to`);
    if (!isArr(b?.when)) problems.push(`${where}.when must be a non-empty array of user actions`);
    if (!isStr(b?.then)) problems.push(`${where}.then is required — the observable outcome`);

    // A behaviour with neither a contract nor UI steps cannot be verified by anything.
    if (b?.contract === undefined && !isArr(b?.when)) {
      problems.push(`${where} has no contract and no steps — nothing could verify it`);
    }
    validateContract(b?.contract, where, problems);
  }

  if (problems.length) throw new SpecError(problems);

  return Object.freeze({
    id: s.id,
    area: s.area,
    title: s.title ?? s.area,
    routes: Object.freeze([...(s.routes ?? [])]),
    auth: s.auth ? Object.freeze({ method: s.auth.method ?? "POST", ...s.auth }) : null,
    behaviours: Object.freeze(
      s.behaviours.map((b) =>
        Object.freeze({
          id: b.id,
          title: b.title,
          feature: b.feature,
          given: b.given ?? null,
          when: Object.freeze([...b.when]),
          then: b.then,
          contract: b.contract
            ? Object.freeze({ ...b.contract, method: b.contract.method.toUpperCase() })
            : null,
          // A behaviour may pin its own type; otherwise the tag engine derives it.
          type: b.type ?? null,
          layer: b.layer ?? (b.contract ? "API" : "UI"),
        }),
      ),
    ),
  });
}

/** Read and validate a spec from a JSON file. */
export async function loadSpec(filePath) {
  const fs = await import("node:fs/promises");
  let text;
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch (e) {
    throw new SpecError([`cannot read spec file "${filePath}": ${e.code ?? e.message}`]);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new SpecError([`"${filePath}" is not valid JSON: ${e.message}`]);
  }
  return parseSpec(parsed);
}
