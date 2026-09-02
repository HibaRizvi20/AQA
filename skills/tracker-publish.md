---
name: tracker-publish
description: Create/transition issue-tracker items (test cases, bugs) safely - dry-run first, endpoints from env.
---
# Tracker publish
Endpoints and credentials come from `.env` (`TRACKER_*`) - never hardcoded. **Dry-run by default:**
build the exact payload and show it; do not send until a human confirms at the matching gate. A bug
from a fixed defect states the **correct** expected behaviour, not the old bug text.
