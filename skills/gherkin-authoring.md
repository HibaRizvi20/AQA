---
name: gherkin-authoring
description: Write clear, stakeholder-readable Gherkin scenarios at the right granularity, grounded in the real app.
---
# Gherkin authoring
- Business language, not UI mechanics (`When I open the checkout`, not `When I click #next`).
- Right granularity: a step is a meaningful user action - not one click, not a whole journey (3-7 steps).
- Observable outcomes; a `Background:` for shared preconditions.
- Prefix each scenario with its tracker key; a regression-guard asserts the correct behaviour a fixed bug violated.
- **Tag for pickability:** feature-level `@area:<area>`, per-scenario `@type:<happy|negative|edge|lifecycle|guard>`.
