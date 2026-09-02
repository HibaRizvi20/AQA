---
name: perf-pull
description: Pull run runtimes and logs from the metrics API and summarise where the time goes. Report-only.
---
# Perf pull
Pull recent run history + per-step durations from the configured metrics API (from `.env`).
Summarise where the time goes and how it scales with load. Report-only; raise a bug only on a clear,
defined budget breach (e.g. p95 > target), with evidence. Never file known non-determinism as a bug.
