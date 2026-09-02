---
name: live-selector-verify
description: Confirm a selector against the running app; on absence, emit a dated skip naming the blocking ticket.
---
# Live selector verify
Never trust a selector from a doc or a prototype. Before a step relies on an element, confirm it
exists in the **running app**. Selector hierarchy (highest trust first): stable test id
(`data-testid`) -> accessible role + name -> label / placeholder -> visible text -> CSS (last resort).
If the element is absent, emit a **skipped** test with a dated annotation naming the blocking ticket -
never a silent skip, never a guess.
