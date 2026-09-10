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

The pipeline runs on **Node alone**. There is no model in the execution path, no API key, and no
install step — so the same spec against the same build produces the same artifacts, and a
difference between two runs is a difference in the app.

```bash
cp .env.example .env          # APP_BASE_URL and API_BASE_URL are required
npm test                      # 81 unit + integration tests, no dependencies

# see it work against the bundled demo app
npm run demo:app &            # a small app with three deliberate defects
npm run demo                  # stops at CP1
npm run aqa approve spec-demo-items CP1
npm run demo                  # ... and so on through CP5
```

The demo run ends with **6 passed · 3 failed** — the three defects planted in the demo app, found
by the pipeline itself. CI asserts exactly those three: a fully green demo run would mean the
pipeline had stopped looking.

### Commands

| Command | Does |
|---|---|
| `node pipeline/orchestrator.mjs run <spec.json>` | run until the next unapproved gate |
| `node pipeline/orchestrator.mjs status <runId>` | where the run got to |
| `node pipeline/orchestrator.mjs approve <runId> CP1` | clear a gate and continue |
| `node pipeline/orchestrator.mjs reject <runId> CP1 --reason "…"` | send the guarded phase back, discarding what was derived from it |

Add `--send` to let the Tracker Publisher actually write. Without it every external write is a
dry-run: the payload is built, shown, and not sent.

An artifact is written per phase under `pipeline/runs/<runId>/artifacts/`. A run that found real
failures exits **2**, so CI can act on it; a configuration or spec problem exits **1**.

### The spec

A spec is what makes this runnable without a model: it states behaviours in a structured form,
and every phase is a deterministic transform over it. A model is useful for turning a paragraph
of prose *into* this shape — it is not needed to run the pipeline.

```jsonc
{
  "id": "spec:demo-items",
  "area": "items",
  "routes": ["/", "/items-page"],
  "auth": { "path": "/login", "tokenField": "accessToken" },
  "behaviours": [{
    "id": "DEMO-122",
    "title": "Re-adding a previously deleted link saves it again",
    "feature": "add item",
    "when": ["I save the same link again"],
    "then": "it is saved again as a fresh entry",

    // Optional. With a contract the behaviour is executed for real; without one it is
    // reported as skipped WITH that reason, never as a pass.
    "contract": {
      "method": "POST", "path": "/v1/items",
      "body": { "url": "https://example.com/{run}" },   // {run} is unique per run
      "expect": { "status": 201, "hasFields": ["id"] },
      "setup": [                                        // runs first; `capture` feeds {id}
        { "method": "POST", "path": "/v1/items", "body": { "url": "https://example.com/{run}" },
          "expect": { "status": 201 }, "capture": "id" },
        { "method": "DELETE", "path": "/v1/items/{id}", "expect": { "status": 204 } }
      ]
    }
  }]
}
```

`{run}` is substituted with a per-run value through both paths and bodies, so a suite can be
re-run against a stateful app without manual cleanup. Three consecutive runs against the same
demo app give byte-identical results.

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
