# AQA conventions - the standard the agents write to

## Suite layout
- UI tests: `tests/ui/*.spec.ts`  - API tests: `tests/api/*.spec.ts`
- Page objects (shared): `src/shared/ui`  - Gherkin feature + steps: co-located under `tests/features/`

## Naming
Every test title carries its tracker key (traceability). Never leave a placeholder key permanent.

## Selector hierarchy (highest trust first)
1. `data-testid`  2. role + name (`getByRole`) / label / placeholder  3. visible text  4. CSS (last resort)
Live-verify every selector; if absent, emit a dated skip naming the blocking ticket.

## Hard rules
- **Self-contained tests** - each navigates itself and restores anything it mutated.
- **A 2xx is not success** - assert the inner payload/status.
- **Page-object freeze** - agents add inline selectors with a fixed annotation, never edit shared page objects.
- **Mock-first** for iteration; go live for selector verification and the regression gate.

## Test tags (pick by area + type)
Every scenario is tagged. Areas: `checkout, search, cart, account, catalog, other`.
Types: `happy, negative, edge, lifecycle, guard` (+ optional `@smoke`).
Pick a subset: `AQA_TAGS="@area:checkout and @type:negative" npm run test:bdd`, or
`npx playwright test --grep "@type:edge"`.
