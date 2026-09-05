---
name: ongboarding-ai-native-sdlc
description: Run non-trivial Ongboarding product and engineering work through a lightweight AI-native discovery, specification, build, evaluation, and maintenance workflow while controlling context and token cost.
---

# Ongboarding AI-native SDLC

Use this skill for features, bug fixes, migrations, agent behavior changes, production incidents, and product investigations that will lead to implementation. Keep the repository's `AGENTS.md` and domain invariants authoritative.

## Scale the process to the work

- **Small:** a local, reversible edit with clear intent and one affected path. State intent, success check, and result in the task conversation. Do not create artifact files.
- **Standard:** a feature or bug spanning multiple paths, an unclear product behavior, or a change with external side effects. Create `.ai/<task>/intent.md`, `spec.md`, and `plan.md` from the compact templates in [references/templates.md](references/templates.md).
- **Critical:** a migration, authorization or privacy change, autonomous applicant communication, irreversible production mutation, or cross-cutting architecture change. Use the Standard artifacts, add explicit failure and rollback behavior to `spec.md`, and record evaluation evidence in `.ai/<task>/eval.md`.

Do not expand a small task merely to satisfy the process. If writing the artifacts would cost more than the implementation and would not clarify a decision, keep them in the conversation.

## Workflow

1. **Discovery:** inspect the smallest authoritative sources first. Ask focused follow-up questions only when the answer changes product behavior, risk, or acceptance criteria. Capture user intent and unresolved decisions in `intent.md` for Standard and Critical work.
2. **Spec:** translate intent into observable behavior, boundaries, data changes, failure behavior, and acceptance checks. Refer to repository paths instead of copying source or existing documentation.
3. **Plan:** list independent implementation slices, their owners when parallel work helps, and the cheapest meaningful verification for each slice. Use separate worktrees only when agents would otherwise edit overlapping state or when isolation materially lowers risk.
4. **Build:** make the smallest changes that satisfy the spec. Keep agents on bounded, independent tasks and give each only the relevant artifact plus source paths.
5. **Evaluate:** run deterministic checks first. Then exercise changed user journeys in a real browser, including responsive layout when relevant. Save concise evidence; retain screenshots or videos only when they clarify a failure or review decision.
6. **Review and operate:** review diffs against intent, repository rules, and the absolute no-confirmation-language invariant. For incidents, diagnose from logs and current state, then create or update an intent artifact before a non-trivial fix.

Human judgment is required when product policy is unresolved, a high-impact applicant outcome is being decided, acceptance criteria materially change, or an irreversible external action lacks existing authorization. Do not add a new approval stop when the user has already authorized the concrete action.

## Token discipline

- Pass artifact paths and diffs, not whole files or repeated conversation history.
- Keep each artifact declarative and short; update only changed sections.
- Use `rg`, type checks, tests, build output, SQL checks, and browser assertions for deterministic facts. Use a model for interpretation and decisions.
- Delegate only independent work whose result can be merged as a compact finding or diff. Avoid several agents rediscovering the same code.
- Prefer one authoritative summary over parallel narrative reports. Record command, outcome, and material exception; omit routine logs.
- Reuse static repository rules through `AGENTS.md` and this skill. Do not restate them in every artifact.
- Use a smaller/faster model for mechanical extraction or classification only when available and adequate; keep architectural, safety, and ambiguous product decisions on the strongest suitable model.

