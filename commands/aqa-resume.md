---
description: Resume an interrupted AQA run from its state file - show where it stopped and continue, without re-running completed phases.
argument-hint: <scope-id>
---
Resume the AQA pipeline for **$ARGUMENTS**. Show the next pending phase / blocking gate from the state
file. If awaiting a gate, present that artifact and wait. Never re-run a phase already marked done.
