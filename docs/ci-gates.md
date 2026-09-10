# CI and release gates

This page maps every gate in specification section 36 to the workflow,
script, or test file that enforces it today. A gate is `covered` only
when a checked-in test or workflow step fails when the gate breaks. A
gate is `pending` when nothing enforces it yet; each pending gate names
an owner. Every mapping below was verified by reading the named files.

## Workflows

`.github/workflows/ci.yml` runs on every pull request and on every push
to `main`. It has three jobs:

- `verify` runs the repository secret scan, then `pnpm run ci`. That
  command runs `format:check`, `lint`, `typecheck`, `boundaries`, and
  the full vitest suite.
- `dependency-audit-report` runs `pnpm audit --prod --audit-level=high`
  with `continue-on-error`. The job reports and never blocks. See
  gate 14 below for the reason.
- `tests` runs the full test suite again on the Node matrix. The matrix
  holds one entry, Node 24, because `package.json` engines support one
  major. The entry keeps the shape for future patch levels.

`.github/workflows/nightly.yml` runs at 03:17 UTC and on demand. It has
three jobs: `extended-tests`, `schedule-materialization`, and
`compile-performance`.

## Section 36.1 pull-request gates

| Gate | Status | Enforced by |
| --- | --- | --- |
| 1. Format, lint, typecheck, boundaries | Covered | `pnpm run ci` in the `verify` job: `format:check`, `lint`, `typecheck`, `boundaries` scripts. |
| 2. Unit tests | Covered | `pnpm run ci` and the `tests` job, both run `vitest run` over `packages/**`, `apps/**`, `tests/**`. |
| 3. Compiler golden corpus, no unreviewed differences | Covered | `packages/openapi/tests/golden.test.ts` pins `ContractIR` goldens and fails on drift. `UPDATE_GOLDEN=1` regenerates them for review. `packages/openapi/tests/corpus.test.ts` walks the fixture corpus. |
| 4. Black-box HTTP conformance | Covered for HTTP | `packages/gateway/src/conformance.test.ts` drives the gateway over a real loopback socket. Also `server.test.ts`, `params.test.ts`, `generate.test.ts`. |
| 4. MCP conformance | Pending, owner: `@oal/tools`, Phase 7 | The tools package covers transport kinds and envelopes (`packages/tools/src/invoke.test.ts`, `envelope.test.ts`). No MCP protocol conformance suite exists yet. |
| 5. Steel golden-pack parity | Covered | `packages/testkit/src/steel-parity-golden.test.ts` pins the frozen Steel golden trace. `steel-parity.test.ts` and `steel-pack.test.ts` pin section 39.5 behavior. |
| 6. Fake-agent runner integration | Covered | `packages/runner/src/integration-trial.test.ts` runs scripted fake agents end to end through the loopback exposure. `packages/mock-adapter` and `packages/agent-generic` supply the fakes. |
| 7. Determinism of identical seeded runs | Covered | `packages/runner/src/integration-determinism.test.ts` checks byte identity on a pinned port, normalized identity on ephemeral ports, and order independence. |
| 8. Isolation of parallel runs | Covered | `packages/runner/src/integration-isolation.test.ts` checks distinct ports, credential sets, workspaces, and evidence trees for parallel trials. |
| 9. Redaction canary, zero leaks | Covered | `packages/runner/src/integration-isolation.test.ts` scans every evidence file for minted tokens. `packages/evidence/src/redaction.test.ts` and `packages/report/src/redact.test.ts` test the redactors. `packages/agent-adapter/src/events.test.ts` tests `createSecretRedactor`. |
| 10. No outbound network | Partial | The exposure binds loopback only (`DEFAULT_EXPOSURE_HOST` in `packages/runner/src/exposure.ts`) and the compiler denies remote references (`OAL-REF-REMOTE-DISABLED`, `packages/openapi/tests/compile.test.ts`). No test asserts the absence of egress at the process level. Pending, owner: `@oal/runner`. |
| 11. No host process or filesystem side effect | Partial | `packages/runner/src/workspace.test.ts` checks that a trial writes only declared materials and reports undeclared files. `packages/behavior-runtime/src/host.test.ts` checks the behavior child process. The real-agent adapters that spawn host processes are a Phase 7 surface. Pending for that surface, owner: `@oal/agent-adapter`. |
| 12. Restart, replay, and crash recovery | Partial | Replay is covered: `packages/report/src/replay.test.ts` and `apps/cli/src/replay.test.ts`. Retry and recovery classification: `packages/report/src/aggregate.test.ts`. Re-execution into a fresh store and resume refusal: `packages/runner/src/integration-trial.test.ts`. Forced-crash recovery is pending, owner: `@oal/runner` (nightly lane). |
| 13. CLI help and config schema snapshots | Covered | `apps/cli/src/help.test.ts` pins the command registry and rendered help. `tests/schemas.test.ts` pins the schema directory listing and the valid and invalid goldens of every schema, including `run-profile.v1` and `pack.v1`. Assertions are inline; no literal snapshot files exist. |
| 14. Dependency license and vulnerability scan | Partial | Vulnerability: the `dependency-audit-report` job runs `pnpm audit --prod --audit-level=high` as a non-blocking report. License scan: pending, owner: release engineering. |
| 15. Repository secret scan | Covered | The `verify` job runs `node scripts/secret-scan.mjs`. The allowlist is `.github/secret-scan-allowlist.txt`. |
| 16. StudyProtocol, PhasePlan, lock, assignment, immutability goldens | Covered | `packages/study-ir/src/protocol.test.ts`, `phase.test.ts`, `lock.test.ts`, `compile.test.ts` (compile determinism). `packages/scheduler/src/schedule.test.ts` pins the canonical schedule digest, `events.test.ts` the assignment ledger, `ids.test.ts` control ids, `seeds.test.ts` run seeds. `tests/schemas.test.ts` covers the goldens of `study-protocol.v1`, `phase-plan.v1`, `protocol-lock.v1`, `assignment-schedule.v1`, and `assignment-event.v1`. |
| 17. Participant-surface inventory, strict cue scan, approved diff | Covered | `packages/runner/src/surface.test.ts` compiles and verifies surface manifests. `surface-check.test.ts` compares cell surfaces and applies the provenance policy. `cue.test.ts` builds the cue audit. `prompts.test.ts` blocks untrusted template blocks. The approved-diff rule is enforced by `packages/contract-variant/src/patch.test.ts` and `model.test.ts`. |
| 18. ContractVariant checks | Covered | Allowlist: `packages/contract-variant/src/patch.test.ts`. Canonical immutability: `endtoend.test.ts` materializes the set twice byte for byte, `model.test.ts` rejects base bytes that miss the pinned digest. Handler parity: `model.test.ts` drops adapters without the required members. Documentation parity: `model.test.ts` checks the documentation digest over facts and placements. Semantic parity: `model.test.ts` derives semantic entries from the pack event registry. |
| 19. Atomic semantic events, separate documentation exchange | Covered | `packages/behavior-api/src/execute.test.ts` commits or keeps state atomically and rejects unregistered or misversioned semantic events. `packages/documentation-facade/src/facade.test.ts` serves the documentation exchange on separate routes. `packages/evaluator/src/evaluate.test.ts` grades both streams separately. `tests/schemas.test.ts` covers the `semantic-event.v1`, `semantic-event-registry.v1`, and `documentation-event.v1` goldens. |
| 20. Compatibility key, denominator, replacement, numeric reference | Covered | Compatibility keys and the pooling gate: `packages/study/src/compatibility.test.ts` and `packages/report/src/compare.test.ts`. Denominators of section 27.3: `packages/report/src/aggregate.test.ts`. Replacement: `packages/scheduler/src/events.test.ts` (held slot activation, replacement policy) and `packages/runner/src/disposition.test.ts` (retry lineage). Numeric references: `packages/statistics/src/statistics.test.ts` uses checked-in reference vectors. |

No pull-request test invokes a paid model by default. The paid path
needs an explicit operator confirmation, which
`packages/runner/src/preflight.test.ts` enforces.

## Section 36.2 nightly gates

| Lane | Status | What runs |
| --- | --- | --- |
| Extended fuzzing | Partial | `extended-tests` runs the full suite. The property suite (`packages/openapi/tests/property.test.ts`) runs 300 fixed-seed iterations per property. It is iteration-bounded, not duration-bounded. Pending: a duration-based fuzz loop, owner: `@oal/openapi`. |
| Linux and macOS local runner | Pending | `nightly.yml` runs on `ubuntu-latest` only. Add a macOS entry when a runner is chosen, owner: release engineering. |
| Supported Node patch matrix | Pending | One major is supported (`package.json` engines). The `tests` job in `ci.yml` holds the single-entry matrix for patch levels. |
| Container isolation integration | Pending | No container harness exists yet, owner: `@oal/runner`. |
| Large-document performance | Covered | `compile-performance` runs `scripts/perf-probe.mjs`. See the budget section below. |
| Concurrent and forced-crash recovery | Partial | Concurrency is covered on every pull request by `packages/runner/src/integration-isolation.test.ts`. Forced crash is pending, owner: `@oal/runner`. |
| Hosted tenant isolation | Pending | Not implemented. |
| Pinned, cost-capped, approved real-agent cohorts | Pending | Not implemented. No nightly job may spend money by default. |
| Variance, disposition, integrity, replacement, denominator report for model-backed evals | Pending | Needs model-backed evals. The unit coverage for each report stage lives in `packages/report` and `packages/statistics`. |
| Repeated same-seed materialization and shuffled-order balance | Covered | `schedule-materialization` runs `scripts/schedule-balance.mjs`. The per-run invariants are unit tested in `packages/scheduler/src/schedule.test.ts`. |

## Section 36.3 release gates

No release workflow exists yet, so these gates run locally or stay
pending. Every gate below names its local command where one exists.

- PR and nightly gates green: run `pnpm run ci`, then the three nightly
  jobs. Covered by the workflows once branch protection requires them.
- Acceptance completeness: run `pnpm run readiness`. The command reads
  `tests/acceptance.map.json` and exits `1` while any criterion of a
  required milestone is partial, missing, or proven only by constructed
  evidence where live evidence is required. Continuous integration does
  not run it on purpose: `pnpm run ci` verifies an honest map, and the
  readiness gate fails while required behavior is missing. Covered by
  `tests/release-readiness.test.ts`, which pins the gate semantics and
  the command-line exit.
- No unwaived critical or high vulnerability: run
  `pnpm audit --prod --audit-level=high`. The CI job reports it. The
  waiver list is pending, owner: release engineering.
- SBOM and signed provenance: pending, owner: release engineering. No
  release artifact exists yet.
- Non-root container: pending. No container is published.
- Clean install and package smoke test: run
  `pnpm install --frozen-lockfile && pnpm run ci`. The CLI smoke test is
  `node --experimental-transform-types apps/cli/src/index.ts --help`.
  The transform flag is needed because the CLI ships TypeScript source.
- Artifact, state, API-event, semantic-event, documentation-event, and
  study schema compatibility: partial. `tests/schemas.test.ts` validates
  every schema and its goldens, and `packages/report/src/compare.test.ts`
  gates report compatibility. A versioned compatibility matrix across
  releases is pending, owner: release engineering.
- Supported pack and schema version matrix: pending, owner: `@oal/pack`.
- Reproducible corpus output: covered on every pull request by
  `packages/openapi/tests/golden.test.ts` and `corpus.test.ts`.
- Executable documentation examples: pending. The commands in
  `examples/README.md` are manual, owner: documentation.
- Published capability matrix matches implementation: partial.
  `docs/capability-matrix.md` is maintained by hand and
  `packages/openapi/tests/capability.test.ts` tests the report builder.
  No test compares the document with the implementation. Pending, owner:
  documentation.
- Retention and redaction review for hosted releases: partial.
  Redaction is tested (gate 9). The retention review is a hosted-release
  checklist that does not exist yet, owner: release engineering.

## Section 36.4 performance budgets

The specification sets the reference budget on a documented reference
machine: a 1 MiB, 500-operation contract should compile within 2 seconds
p95 and below 512 MiB RSS.

`scripts/perf-probe.mjs` measures this on the CI runner. The runner is
the reference machine for now, and its speed is not calibrated. Treat
the numbers as raw data, not as certified compliance.

The probe scales the budget to each document by the binding ratio of
operations or bytes, with a floor of 5 percent of the reference budget.
It fails only on a gross regression: a median above four times the
scaled budget. This margin absorbs runner noise. The probe reports
median, p95, budget, and peak resident size for every document.

Reference numbers from one local run on Node 24:

| Document | Operations | Bytes | Median | Budget |
| --- | --- | --- | --- | --- |
| `examples/quickstart.json` | 5 | 10293 | 2.1 ms | 100 ms |
| `examples/steel-v1.json` | 41 | 269750 | 14.6 ms | 515 ms |
| `examples/e2b.yaml` | Skipped | 127133 | Not compiled | Not compiled |

`examples/e2b.yaml` does not compile today. The parser folds its
multi-line plain scalars, and the compiler then rejects the document
with `OAL-OAS-ROUTE-AMBIGUOUS`: `/templates/aliases/{alias}` and
`/templates/{templateID}/tags` can match the same request path. The
probe reports the document as skipped, because a compile diagnostic is
not a performance regression. The vendor snapshot keeps the defect, so
the probe carries one large document instead of two.

The remaining budgets, request latency, server readiness, and limit
termination, have no probe yet. Pending, owner: `@oal/gateway`.

## Scripts

- `scripts/secret-scan.mjs`: zero-dependency secret scanner. Exit 0 is
  clean, 1 reports findings, 2 is an operational error.
- `scripts/perf-probe.mjs`: compile timing probe. Exit 1 means a gross
  regression.
- `scripts/schedule-balance.mjs`: scheduler materialization and balance
  checks. Exit 1 means a check failed.

The probes import workspace TypeScript source directly. Plain node
cannot load it in strip-only mode, so both scripts re-execute themselves
once with `--experimental-transform-types`. Run them with
`pnpm run probe:compile` and `pnpm run probe:schedule`, or with plain
`node scripts/<name>.mjs`.
