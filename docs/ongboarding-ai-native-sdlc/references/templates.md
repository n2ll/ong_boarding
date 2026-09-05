# Compact artifact templates

Create these files only for Standard or Critical work. Prefer short YAML fields and path references over prose.

## `intent.md`

```md
# <task>
goal: <user-visible outcome>
trigger: <event or problem>
users: [<roles>]
must:
  - <required behavior>
must_not:
  - <forbidden behavior>
decisions:
  - <resolved product decision>
open:
  - <question that changes behavior; omit if none>
success:
  - <observable acceptance criterion>
```

## `spec.md`

```md
# <task> spec
flow:
  - <input/event> -> <system behavior> -> <visible result>
boundaries:
  - <scope boundary or invariant>
data:
  - <schema/API/state change or "none">
failure:
  - <failure mode> -> <safe behavior>
verification:
  - <deterministic check>
  - <browser journey>
rollback: <Critical work only>
```

## `plan.md`

```md
# <task> plan
- [ ] <small implementation slice> — verify: <check>
- [ ] <small implementation slice> — verify: <check>
- [ ] final diff review against intent/spec
```

## `eval.md`

```md
# <task> evaluation
- <check>: PASS|FAIL — <one-line evidence>
- <journey>: PASS|FAIL — <one-line evidence or artifact path>
remaining_risk:
  - <material risk only; omit if none>
```

