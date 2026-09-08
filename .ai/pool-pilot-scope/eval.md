# Evaluation — 2026-09-08
- `node --experimental-strip-types --test lib/agent/kill-switch.test.ts lib/agent/response-containment.test.ts lib/pool-preferences.test.ts lib/admin/agent-pilot-targets.test.ts lib/admin/agent-mode-view.test.ts`: 42 passed.
- Scope gate: selected people/jobs and fresh inbound only; missing scope/old inbound/expired or malformed settings remain OFF. Existing global activation and reminder containment tests pass.
- Activation route: eligible candidates produce a one-hour bounded session; paused/opted-out candidates and preparation failure cannot store it. Candidate preparation updates only null stages.
- `npx playwright test --config=playwright.pilot.config.ts`: 2 passed. Synthetic data only, external network blocked, provider credentials absent. Mobile preference save/edit/revisit and pilot confirmation/start/stop; no horizontal overflow. Screenshots inspected locally.
- `npx tsc --noEmit`: passed. `npm run build`: passed; existing no-assign-module-variable warnings in unrelated tests only.
- No migration, live data writes, live SMS, AI API calls, or pilot activation. Pool preferences remain self-reported events, separate from exposure filters and marketing consent.
- Operational prerequisite: actual open jobs and manager-selected eligible candidates. No fabricated vacancies from historical examples. Production deployment verification follows the PR checks.
