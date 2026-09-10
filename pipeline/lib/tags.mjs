// Deterministic test tagging: infer @type from a scenario's intent, stamp @area + @type onto
// Gherkin, and validate that every scenario is tagged.
// Used by the Case Designer (stamp) and the Reviewer (enforce).
//
// Two properties this engine must hold, both of which it used to break:
//
//   1. INFLECTION-INSENSITIVE. "delete", "deletes", "deleted" and "deleting" describe the same
//      intent and must produce the same tag. Matching on `\bdelete\b` alone silently tagged
//      "Confirm before deleting a resource" differently from "Confirm before delete".
//
//   2. PRECEDENCE BY SPECIFICITY, NOT BY ARRAY ORDER. A scenario often matches several rules;
//      "Cancelling the delete confirmation keeps the resource" contains both a guard signal
//      (cancelling a confirmation) and a lifecycle signal (delete). The tag must be decided by a
//      declared precedence, not by which regex happens to sit first in the file.
//
// Precedence, strongest first, with the reason each one wins:
//
//   negative   an explicit refusal or rejection is the point of the test, whatever else it mentions
//   guard      the test is about ABORTING an action, so the action it names never completes
//   edge       a boundary value is the point, even when the action is ordinary
//   lifecycle  a state change that actually completes
//   happy      nothing more specific matched

/**
 * Build an inflection-tolerant alternation for a verb.
 *
 *   cancel → cancel | cancels | cancelled | cancelling | canceled | canceling
 *   delete → delete | deletes | deleted    | deleting
 *
 * Both the doubled-consonant (British) and single-consonant (US) forms are accepted, because a
 * spec written by a human will use whichever its author writes, and the tag must not depend on that.
 */
function stem(...verbs) {
  return verbs
    .map((v) => {
      const base = v.replace(/e$/, ""); // delete → delet, cancel → cancel
      const last = base.at(-1);
      const doubled = /[aeiou][bdglmnprt]$/.test(base) ? `${base}${last}` : null;
      const forms = new Set([v, `${base}es`, `${base}s`, `${base}ed`, `${base}ing`]);
      if (doubled) {
        forms.add(`${doubled}ed`);
        forms.add(`${doubled}ing`);
      }
      // longest first, so the alternation cannot match a short prefix and stop early
      return [...forms].sort((x, y) => y.length - x.length).join("|");
    })
    .join("|");
}

// Each rule is [regex, type, why] — `why` is carried into the artifact so a tag is auditable.
export const TYPE_RULES = [
  [
    new RegExp(`\\b(?:${stem("reject", "block", "forbid", "fail", "refuse", "deny")}|invalid|required|cannot|can't|must not|forbidden|outside|unauthorised|unauthorized|too (?:long|many|short|few))\\b`, "i"),
    "negative",
    "asserts a refusal or rejection",
  ],
  [
    new RegExp(`\\b(?:${stem("cancel", "dismiss", "discard", "abort", "warn", "prompt", "confirm")}|unsaved|leaving|navigate away|without saving|are you sure)\\b`, "i"),
    "guard",
    "asserts that an action is confirmed or aborted before it takes effect",
  ],
  [
    new RegExp(`\\b(?:${stem("exceed", "truncate")}|smallest|largest|minimum|maximum|boundary|min|max|zero|none|limit|edge|exactly|first|last|empty|off[- ]by[- ]one)\\b`, "i"),
    "edge",
    "exercises a boundary or limit value",
  ],
  [
    new RegExp(`\\b(?:${stem("delete", "remove", "archive", "disable", "enable", "restore", "expire")}|lifecycle)\\b`, "i"),
    "lifecycle",
    "a state change that completes",
  ],
];

export const DEFAULT_TYPE = "happy";

/**
 * Decide the @type for a piece of scenario text.
 * Returns the type only; use `explainType` when the reason is needed too.
 */
export function deriveType(text) {
  return explainType(text).type;
}

/**
 * Same decision as deriveType, plus why it was made and what else matched.
 * The runner records this so a surprising tag can be audited without re-running anything.
 */
export function explainType(text) {
  const s = String(text ?? "");
  const matched = [];
  for (const [re, type, why] of TYPE_RULES) {
    const m = s.match(re);
    if (m) matched.push({ type, why, on: m[0] });
  }
  if (matched.length === 0) {
    return { type: DEFAULT_TYPE, why: "nothing more specific matched", on: null, alsoMatched: [] };
  }
  const [winner, ...rest] = matched; // TYPE_RULES is ordered by precedence, deliberately
  return { ...winner, alsoMatched: rest.map((r) => r.type) };
}

function tagsAbove(lines, i) {
  const tags = [];
  for (let j = i - 1; j >= 0; j--) {
    const t = lines[j].trim();
    if (t.startsWith("@")) {
      tags.unshift(...t.split(/\s+/));
      continue;
    }
    if (t === "") continue; // a blank line between tags and Scenario is legal Gherkin
    break;
  }
  return tags;
}

const has = (tags, p) => tags.some((t) => t.startsWith(p));

function stepsAfter(lines, i) {
  let s = "";
  for (let j = i + 1; j < lines.length && !/^\s*(Scenario:|Scenario Outline:|Feature:|@)/.test(lines[j]); j++) {
    s += " " + lines[j];
  }
  return s;
}

const SCENARIO = /^\s*Scenario(?: Outline)?:/;

/**
 * Stamp a feature-level @area and a per-scenario @type where missing.
 * Idempotent: an already-tagged scenario is left exactly as it is.
 */
export function applyTags(gherkin, area) {
  if (!area || !String(area).trim()) throw new Error("applyTags: an area is required to stamp @area");
  const lines = String(gherkin ?? "").split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const t = raw.trim();
    if (/^Feature:/.test(t) && !has(tagsAbove(lines, i), "@area:")) {
      out.push(`@area:${area}`);
    }
    if (SCENARIO.test(raw) && !has(tagsAbove(lines, i), "@type:")) {
      const indent = raw.match(/^\s*/)[0];
      out.push(`${indent}@type:${deriveType(t + " " + stepsAfter(lines, i))}`);
    }
    out.push(raw);
  }
  return out.join("\n");
}

/** Report every scenario missing @area or @type. An empty array means all are tagged. */
export function validateTags(gherkin) {
  const lines = String(gherkin ?? "").split("\n");
  const featTagged = lines.some((l, i) => /^Feature:/.test(l.trim()) && has(tagsAbove(lines, i), "@area:"));
  const missing = [];
  for (let i = 0; i < lines.length; i++) {
    if (!SCENARIO.test(lines[i])) continue;
    const tags = tagsAbove(lines, i);
    const noArea = !(featTagged || has(tags, "@area:"));
    const noType = !has(tags, "@type:");
    if (noArea || noType) {
      missing.push({
        scenario: lines[i].replace(/^\s*Scenario(?: Outline)?:\s*/, "").slice(0, 80),
        missing: [noArea && "@area", noType && "@type"].filter(Boolean),
      });
    }
  }
  return missing;
}
