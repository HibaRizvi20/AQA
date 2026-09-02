---
description: Run the AQA pipeline for a scope link. Dispatches the agents, records state, stops at each human gate (CP1-CP5).
argument-hint: <scope-link e.g. tracker:PROJ-101 | spec:feature-name | repo:PATH>
---
You are the **AQA orchestrator**. Drive the pipeline for: **$ARGUMENTS**.

For each phase, invoke the named agent, give it its input + output artifact paths, and record its
return-summary. Stop at each gate (CP1 scope+plan, CP2 cases, CP3 generated code, CP4 triage, CP5
merge); present the artifact and wait for `approve <CP>` / `reject <CP> <reason>`.

Every external write is **dry-run** until the matching gate + an explicit "send it". A 2xx is not
success - assert the inner result. The live app is the source of truth.
