// Deterministic test tagging: infer @type from a scenario's intent, stamp @area + @type onto Gherkin,
// and validate that every scenario is tagged. Used by the Case Designer (stamp) and Reviewer (enforce).
const TYPE_RULES = [
  [/\b(reject|invalid|blocked|required|empty|cannot|fails?|forbidden|outside|too (long|many))\b/i, "negative"],
  [/\b(delete|disable|enable|remove|archive|lifecycle)\b/i, "lifecycle"],
  [/\b(unsaved|discard|warn|leaving|navigate away|confirm|prompt)\b/i, "guard"],
  [/\b(smallest|largest|minimum|maximum|boundary|min|max|zero|limit|edge)\b/i, "edge"],
];
export function deriveType(text) {
  for (const [re, t] of TYPE_RULES) if (re.test(text)) return t;
  return "happy";
}
function tagsAbove(lines, i) {
  const tags = [];
  for (let j = i - 1; j >= 0; j--) {
    const t = lines[j].trim();
    if (t.startsWith("@")) { tags.unshift(...t.split(/\s+/)); continue; }
    break;
  }
  return tags;
}
const has = (tags, p) => tags.some((t) => t.startsWith(p));
function stepsAfter(lines, i) {
  let s = "";
  for (let j = i + 1; j < lines.length && !/^\s*(Scenario:|Feature:|@)/.test(lines[j]); j++) s += " " + lines[j];
  return s;
}
// Stamp a feature-level @area and a per-scenario @type where missing. Idempotent.
export function applyTags(gherkin, area) {
  const lines = gherkin.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i], t = raw.trim();
    if (/^Feature:/.test(t) && !has(tagsAbove(lines, i), "@area:")) out.push(`@area:${area}`);
    if (/^Scenario:/.test(t) && !has(tagsAbove(lines, i), "@type:")) {
      out.push(`${raw.match(/^\s*/)[0]}@type:${deriveType(t + " " + stepsAfter(lines, i))}`);
    }
    out.push(raw);
  }
  return out.join("\n");
}
// Return the scenarios missing @area or @type. Empty array = all tagged.
export function validateTags(gherkin) {
  const lines = gherkin.split("\n");
  const featTagged = lines.some((l, i) => /^Feature:/.test(l.trim()) && has(tagsAbove(lines, i), "@area:"));
  const missing = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*Scenario:/.test(lines[i])) continue;
    const tags = tagsAbove(lines, i);
    if (!(featTagged || has(tags, "@area:")) || !has(tags, "@type:")) missing.push(lines[i].replace(/^\s*Scenario:\s*/, "").slice(0, 60));
  }
  return missing;
}
