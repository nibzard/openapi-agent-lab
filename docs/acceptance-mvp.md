# MVP acceptance report

This report records how the repository proves the acceptance criteria of
specification section 42, plus the acceptance controls that the
[review fix plan](review-fix-plan.md) added. The map is
`tests/acceptance.map.json`; the suite is `tests/acceptance.test.ts`.

## Method

The work followed these steps:

1. Map every criterion AC-001 through AC-120, plus the remediation
   controls AC-121 through AC-127, to the automated tests that prove it.
   One entry per criterion records the group, the claim, the milestone,
   the status, and the proving tests.
2. Run the full suite with `pnpm run test`. The acceptance suite checks
   the map: every referenced file exists, every referenced test title
   appears in that file, and the coverage counts below are generated
   from the map itself.
3. Keep the map honest about what is not done. A criterion that is
   partially enforced or not enforced carries a deferred record that
   names its owner.
4. Keep completeness out of continuous integration. The suite verifies
   an honest map; `pnpm run readiness` (section below) is the gate that
   fails while required behavior is missing.

## Status vocabulary

- **covered**: at least one automated test enforces the claim.
- **corrected**: the requirement text itself was wrong. The correction
  record names the corrected requirement and its authority, and the
  enforcing tests satisfy the corrected requirement in full.
- **partial**: the enforcing tests cover the claim in part. The
  remainder is deferred with a named owner. Partial never satisfies
  release readiness.
- **missing**: no test enforces the claim yet.

A criterion marked `requires_live` demands success through a real
execution path. Constructed traces and replayed goldens cannot satisfy
it; the recorded evidence must be live.

## Corrections

A correction records where the specification text, not the build, was
wrong. The specification stays normative for future revisions; the map
enforces the corrected requirement.

| Identifier | Specification text | Correction | Basis |
| --- | --- | --- | --- |
| AC-080 | "Steel ContractIR contains exactly 37 path operations." | The frozen Steel source declares 41 operations. The pack compiles all 41 keys; exact-completeness holds against the frozen source inventory. | SPEC.md section 39.1 (source of truth); `packages/testkit/src/steel-pack.test.ts` and `steel-parity.test.ts` pin the 41-operation surface. |
| AC-081 | "Steel exact-completeness maps all 37 operations once with no extra key." | Every one of the 41 declared operations maps exactly once and no undeclared key appears. | SPEC.md section 39.1; `packages/testkit/src/steel-parity.test.ts` compares the pack surface with the compiled source surface. |

## Deviations

A deviation records where this build enforces the intent of a criterion
but not its literal text. Unlike a correction, the remainder stays
deferred and blocks release readiness.

| Identifier | Specification text | Deviation | Enforced by |
| --- | --- | --- | --- |
| AC-060 | Limit coverage with bounded failure tests. | Compiler, request, connection, state, and configured ceiling paths have bounded tests. Study surface, log, disk, and full wall-time enforcement remain incomplete. | `packages/config/src/limits.test.ts`, `packages/openapi/tests/yaml.test.ts`, `packages/runner/src/exposure.test.ts`. |
| AC-082 | "Existing ten prototype tests pass or have one-to-one equivalent parity tests with recorded mapping." | Seven of the ten prototype signal areas map to real parity tests. Three need scenario behavior handlers. | `packs/steel-computer/PARITY.md`; `packages/testkit/src/steel-parity.test.ts`. |
| AC-083 | "Golden fake-agent checkpoint recovery passes the ordered trace and final-state rubric." | The rubric passes on the recorded golden trace. A live end-to-end pass needs the scenario backend; contract-mode responses are stateless. This criterion requires live evidence, which the golden replay cannot provide. | `packages/testkit/src/steel-pack.test.ts`; `packages/runner/src/integration-trial.test.ts`. |
| AC-084 | "Current Steel auth, lifecycle, file, environment, checkpoint, idempotency, SSE, binary, and stand-in behavior matches frozen golden cases." | Auth, lifecycle, files, checkpoints, and binary responses match frozen goldens in contract mode. Idempotency replay, SSE streams, and safe stand-ins need the scenario backend. | `packages/testkit/src/steel-parity-golden.test.ts`; `packages/testkit/src/steel-parity.test.ts`. |

## Deferred registry

Every partial or missing criterion names the work package that owns the
remainder. `F2` through `F7` refer to the
[review fix plan](review-fix-plan.md); `unassigned` means no package
owns it yet.

| Owner | Criteria |
| --- | --- |
| F2 (bounded patterns) | AC-061, AC-121 |
| F3 (analysis correctness) | AC-122, AC-123 |
| F4 (webclip grading) | AC-124 |
| F5 (scenario execution) | AC-082, AC-083, AC-084, AC-120, AC-125 |
| F6 (tool execution) | AC-074, AC-077, AC-116, AC-126 |
| F7 (study execution) | AC-060, AC-101, AC-103, AC-106, AC-108, AC-120, AC-127 |
| unassigned | AC-100, AC-111, AC-113, AC-119 |

AC-120 appears under both F5 and F7 because its remainder needs both the
scenario backend and durable study runs.

## Coverage summary

Status counts per specification group, generated from
`tests/acceptance.map.json` by the acceptance suite.

| Group | Focus | Criteria | Covered | Corrected | Partial | Missing |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| 42.1 | Compiler and capability | 12 | 12 | 0 | 0 | 0 |
| 42.2 | Gateway and contract behavior | 15 | 15 | 0 | 0 | 0 |
| 42.3 | State, behavior, and determinism | 10 | 10 | 0 | 0 | 0 |
| 42.4 | Trace and evidence | 8 | 8 | 0 | 0 | 0 |
| 42.5 | Runner, adapters, and isolation | 10 | 10 | 0 | 0 | 0 |
| 42.6 | Redaction and limits | 6 | 4 | 0 | 2 | 0 |
| 42.7 | Evaluator and reports | 12 | 12 | 0 | 0 | 0 |
| 42.8 | Tool exposure | 6 | 4 | 0 | 2 | 0 |
| 42.9 | Steel migration | 8 | 3 | 2 | 3 | 0 |
| 42.10 | Release completeness | 3 | 3 | 0 | 0 | 0 |
| 42.11 | Cross-cutting and workflow | 10 | 9 | 0 | 1 | 0 |
| 42.12 | Research protocols | 20 | 11 | 0 | 8 | 1 |
| review | Review remediation | 7 | 0 | 0 | 0 | 7 |
| total | | 127 | 101 | 2 | 16 | 8 |

## Release readiness

Section 42 defines the milestone gates: Raw-HTTP MVP, agent-native
tools, workflow, research protocol, and product 1.0 over all of them.
The review found that the previous report treated deferred behavior as
satisfying the Raw-HTTP MVP gate. It does not.

Continuous integration no longer asserts milestone completeness. The
acceptance suite verifies that the map is honest: statuses are valid,
deferred remainders name an owner, and the counts above are generated
from the map.

Release readiness is a separate command:

```bash
pnpm run readiness
```

It exits `1` while any criterion blocks and lists every blocker with its
owner. As of this report, 24 criteria block: 5 in the Raw-HTTP MVP set,
2 in agent-native tools, 1 in workflow, 9 in research protocol, and the
7 remediation controls. The gate passes when every required outcome has
passing evidence, live where live is required.

## Running the acceptance suite

Run the whole suite, including the acceptance map checks:

```bash
pnpm run test
```

Run only the acceptance map checks:

```bash
npx vitest run tests/acceptance.test.ts
```
