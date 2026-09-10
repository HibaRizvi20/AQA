# AQA — Autonomous QA Agents

A framework of narrow, single-purpose AI agents that take a **scope link** (an issue-tracker
epic/story or a plain feature spec) and drive it toward a merged, passing test suite: test cases
published, bugs raised with evidence, coverage recorded — with a **human at five gates**, not an
unattended robot.

> Design & implementation by **Hiba Rizvi**. This is a clean, self-contained demonstration of an
> agent-orchestrated QA workflow, built around a fictional demo app ("Acme Shop"). It uses no
> real credentials, hosts, or proprietary code.

## The idea in one picture

```
scope link ──▶ [Scope Analyst] ─▶ [Test Architect] ─CP1─▶ [Case Designer] ─CP2─▶ [Tracker Publisher]
                                                                                        │
        [Finalise/KB] ◀─CP5─ [Reviewer] ◀─ [Regression] ◀─ [Triage/Self-Heal] ◀─CP4─ [Targeted Run] ◀─CP3─ [Test Generator]

  async, non-blocking:  [Performance]   [Drift Detector]   [Design Parity]   [Eval Analyst]
```

## Principles

- **Intent vs truth.** Docs and designs say what *should* be; they drift. The **live app is the
  only source of truth** — every selector and behaviour is verified against the running app.
- **Gates + dry-run.** Nothing external (a ticket, a pull request, a merge) is sent without the
  matching human gate *and* an explicit confirm. A 2xx is never "success" — the inner result is asserted.
- **Pickable tests.** Every scenario is auto-tagged by `@area` and `@type`, so any subset runs on demand.
- **Never fake green.** If something can't be verified (a feature isn't deployed), the pipeline says so.

## The 12 agents

**Gated authoring pipeline (8):** Scope Analyst · Test Architect · Case Designer · Tracker Publisher ·
Test Generator · Triage / Self-Healer · Reviewer · KB Curator.
**Async tracks (4, non-blocking):** Performance & Logs · Drift Detector · Design Parity · Eval Analyst.

One file per agent under [`agents/`](agents/), each with an explicit "does NOT" clause to prevent
scope-bleed. Full write-up: [`docs/agents-guide.html`](docs/agents-guide.html).

## What's here

| Path | Holds |
|------|-------|
| `agents/` | the 12 agent definitions |
| `skills/` | reusable capabilities (selector-verify, gherkin-authoring, tracker-publish, evidence, perf-pull) |
| `commands/` | the orchestrator + resume + daily-report entry points |
| `pipeline/` | the phase runner (`orchestrator.mjs`), phase modules, and the tag engine (`lib/tags.mjs`) |
| `dashboard/` | the **Runs Explorer** — milestones → cycles → tests → per-test agent trace (`dashboard/index.html`) |
| `docs/` | the architecture guide |
| `tests/features/` | sample Gherkin (playwright-bdd) for the demo app |
| `conventions.md` | the standard the agents write to |

## Run it

```bash
npm install
cp .env.example .env                 # fill in your own demo values
node pipeline/orchestrator.mjs DEMO-101 --status
node pipeline/orchestrator.mjs DEMO-101 --approve CP1
npx playwright test --grep "@area:checkout"     # pick tests by tag
```
Open `dashboard/index.html` for the **Runs Explorer**. It drills down in four levels:

| Route | Level | Shows |
|---|---|---|
| `#/` | **Runs Explorer** | every milestone, the cycles inside it, coverage, dates and how far each cycle got |
| `#/milestone/<id>` | **Milestone** | the cycles in that milestone, with per-cycle coverage and open gates |
| `#/cycle/<id>` | **Cycle** | the individual tests it ran — filter by **type** (positive, negative, edge, guard, UI, API, performance) or by **area** (checkout, auth, …), or list them all |
| `#/test/<test-id>/<agent-id>` | **Agent trace** | that one test, carried through all 12 agents |

The trace is **per test, not per run**. Open a test and each agent shows what it received from the agent before it and what it passes to the agent after it, for that test alone — pre-flight reconciles the written intent across every source and probes the running app, the Scope Analyst receives exactly that, and so on down the chain. Every panel names its neighbour, so the hand-off is never implied.

All 12 agents are in the trace nav: the 8 gated pipeline agents behind five human gates, and the 4 async tracks (Performance & Logs, Design Parity, AI Eval Analyst, Drift Detector) which report but never block a merge. An async track with nothing configured for the target renders as **not-run with its reason**, never as a pass, and the nav dot is derived from the panel so the two can never disagree.

## Skills demonstrated

Agent orchestration & tool design · gated human-in-the-loop workflows · Playwright + playwright-bdd
(BDD/Gherkin) · deterministic-vs-LLM evaluation · test tagging & selective execution · data-flow
dashboards · dry-run-by-default safety design.

## License

MIT — see [`LICENSE`](LICENSE).
