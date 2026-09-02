// Phase 08 - Reviewer. Enforces the tagging convention: an untagged scenario is a blocking finding.
import { validateTags } from "../lib/tags.mjs";
export function review(gherkin){
  const untagged = validateTags(gherkin);
  const findings = [];
  findings.push({ rule:"every scenario tagged @area + @type", verdict: untagged.length?"fail":"pass", note: untagged.join("; ")||"all tagged" });
  return { findings, blocking: findings.filter(f=>f.verdict==="fail").length };
}
