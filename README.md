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
| `dashboard/` | the **Runs Explorer** — a traces-style, searchable flow board (`dashboard/index.html`) |
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
Open `dashboard/index.html` for the Runs Explorer (search runs, open a run's phase-by-phase flow).

## Skills demonstrated

Agent orchestration & tool design · gated human-in-the-loop workflows · Playwright + playwright-bdd
(BDD/Gherkin) · deterministic-vs-LLM evaluation · test tagging & selective execution · data-flow
dashboards · dry-run-by-default safety design.

## License

MIT — see [`LICENSE`](LICENSE).
