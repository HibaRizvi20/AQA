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

AQA drives its own agents. It needs a key, and that is deliberate: the point is a tool that runs
on its own, in CI or on a laptop, not one that only works inside a chat session.

```bash
cp .env.example .env             # APP_BASE_URL and API_BASE_URL are required
export ANTHROPIC_API_KEY=...     # the agents are the execution engine
npm install                      # @anthropic-ai/sdk; playwright is optional

npm test                         # 123 tests of the control layer, no key needed

npm run demo:app &               # a small app with deliberate defects
npm run demo                     # stops at CP1
npm run aqa approve spec-demo-items CP1
npm run demo                     # ... and so on through CP5
```

`--provider` and `--model` select the intelligence. That seam is what makes the comparison below
runnable.

## The architecture

```
                          AQA
                           |
              +------------+------------+
              |                         |
        CONTROL LAYER              INTELLIGENCE
        deterministic                   |
              |                    +----+-----+
        orchestrator               | 12 agents|
        state . gates              +----+-----+
        retries . artifacts             |
        logging . schemas           DECISION
              |                         |
              |                         v
              |                    TOOL CALL
              |                         |
              |              +----------+----------+
              |            probe       UI        tags
              |           API/HTTP  Playwright   files
              |              +----------+----------+
              +-------------------------+
                                   OBSERVATIONS
                                        |
                                        v
                                  AGENT REASONS
```

The rule that decides which half owns a step:

> Never move a decision into deterministic code merely because it can be written as an if/else.
> If it requires understanding a requirement, interpreting evidence, choosing a strategy,
> diagnosing behaviour, generating tests or judging quality, it belongs to an agent.
>
> Never ask an agent to perform an exact mechanical operation. If it is "save this JSON", "run
> this test", "apply this tag", "retry three times" or "create this file", it belongs to code.

The sharpest case is the targeted run. The agent chooses what to run; the runner runs it and
writes the verdict. **A model is never the thing that says a test passed.** The same holds inside
Triage: it proposes a repair, and the repair only counts as healed once the runner re-ran it and
it actually passed.

A remit is held three ways, in increasing strength:

| | |
|---|---|
| **the prompt** | the agent's own definition, including its "You do NOT" clauses, verbatim |
| **capability** | the tools it is handed. The Reviewer is given no file tool, so it *cannot* fix what it finds |
| **structure** | separate invocations, separate artifacts, a human gate between several of them |

A test asserts the second one: if the Reviewer is ever granted file tools, the suite fails.

## Single agent versus twelve

A fair challenge on this architecture is whether the split earns its cost. That is a measurable
question, so it is measured rather than argued.

```bash
npm run ab
```

Mode A is one capable agent with one wide prompt doing the whole workflow. Mode B is the
twelve-agent pipeline. **Both get the same toolbelt, the same application, the same requirement
and the same model**, so the variable under test is the intelligence architecture and nothing
else.

Scoring needs ground truth, so `examples/demo-ground-truth.json` declares what is actually wrong
with the demo app *and* what is deliberately right. Without the traps, "found six issues" cannot
be told apart from "invented six issues", and the false-positive column is the one that decides
whether a QA tool is worth having.

The harness reports requirements understood, ambiguities surfaced, cases generated and executed,
true and false positives, recall and precision, coverage gaps named, self-heal attempts versus
verified heals, human checkpoints, tokens, cost and wall clock.

One run of each on one application is evidence, not proof. Run it across several specs before
believing the shape.

### What it will not do

- **Report a probe it could not run as a pass.** No token, an unresolved placeholder, a failed
  setup step — each is `skipped` with its reason.
- **Stamp the Feature Registry when the run was not clean.** `verified_against_live` stays null
  and the artifact says why.
- **Write a credential to an artifact.** Tokens live in memory for the length of the process; a
  test asserts no artifact contains one.
- **Walk past an unapproved gate**, including on a resume.

## Skills demonstrated

Agent orchestration & tool design · gated human-in-the-loop workflows · Playwright + playwright-bdd
(BDD/Gherkin) · deterministic-vs-LLM evaluation · test tagging & selective execution · data-flow
dashboards · dry-run-by-default safety design.

## License

MIT — see [`LICENSE`](LICENSE).
