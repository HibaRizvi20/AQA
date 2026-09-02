# Résumé blurb — AQA (Autonomous QA Agents)

**Designed and built an agent-orchestrated QA automation framework** — 12 single-purpose AI agents
that turn a scope link (issue-tracker epic or a plain feature spec) into a reviewed, passing test
suite. A gated pipeline (5 human checkpoints, dry-run by default) runs Scope → Architecture →
Case Design → Publish → Generate → Targeted Run → Triage/Self-Heal → Regression → Review →
Finalise, plus four non-blocking async tracks (performance, drift, design-parity, AI-eval).

Highlights:
- **Human-in-the-loop safety:** nothing external is sent without a gate + explicit confirm; the live
  app is the source of truth (every selector verified live); "never fake green" honest degradation.
- **BDD & selective execution:** Gherkin via playwright-bdd; scenarios auto-tagged by area/type so
  any subset runs on demand.
- **Self-healing triage:** classifies each failure (test defect vs product bug vs known-flaky),
  fixes test defects in ≤3 cycles, raises evidenced bugs for the rest.
- **Data-flow dashboard:** a traces-style, searchable Runs Explorer showing each run's phase-by-phase
  input → output.

Stack: Node.js, Playwright, playwright-bdd, LLM agents (Claude Code), deterministic + LLM-as-judge evaluation.
