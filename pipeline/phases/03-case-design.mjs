// Phase 03 - Case Designer. Writes Gherkin and AUTO-STAMPS @area + @type tags via the tag engine.
import { applyTags } from "../lib/tags.mjs";

export function design(objectives, area) {
  const title = (objectives && objectives[0] && objectives[0].title) || "primary happy path";
  const gherkin = [
    `Feature: ${area}`,
    ``,
    `  Scenario: AQA-1 ${title}`,
    `    When I do the main action`,
    `    Then I see the expected result`,
  ].join("\n");
  return { area, gherkin: applyTags(gherkin, area) }; // tags stamped automatically
}
