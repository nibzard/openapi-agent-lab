# Stateful API environments implementation plan

Status: implementation decisions accepted; all tasks below remain pending.
Normative requirements: [SPEC.md section 48](../SPEC.md#48-stateful-environments-milestone).
Created: 2026-10-10.

## Objective

Make OpenAPI Agent Lab usable as a disposable, stateful API environment for
agent development and evaluation. Ship one deeply modeled workflow with a
versioned behavioral test corpus that can exercise both the emulator and a
real service sandbox.

The product promise is: launch a known world, let an agent act, inspect the
consequences, reproduce or branch the experiment, and show which modeled
behaviors have been checked against the service.

OpenAPI defines the interface. A behavior module defines domain transitions.
The corpus tests those transitions. Agent rubrics evaluate task outcomes.
Keep those responsibilities distinct so schema validity or a passing agent
score cannot be mistaken for service fidelity.

## Starting point

The current repository already provides much of the foundation:

| Area | Current evidence | Remaining work |
| --- | --- | --- |
| Pack format | Versioned contracts, behavior modules, state schemas, tasks, and rubrics in `packs/webclip/pack.yaml` | Portable authoring and a reusable behavioral corpus |
| Stateful execution | `packages/runner/src/scenario-runtime.ts` connects behavior execution to committed state and evidence | Reuse the runtime outside participant trials |
| Domain behavior | Webclip implements eight operations with distinct IDs, lifecycle transitions, deletion, and live quota | Validate a narrow workflow against a real service |
| Determinism | State-store clock, IDs, seeded randomness, and frozen run inputs | Explicit world lifecycle controls and complete checkpoints |
| Evaluation | Semantic events, traces, final state, and deterministic rubrics | Separate emulator correctness from agent success |
| Fidelity probe | `oal probe` checks live replies against a frozen contract | Sequence-based behavioral comparison with dynamic bindings |
| Standalone server | Contract mode works; scenario serving is refused | A supported `oal serve --mode scenario` path |

Webclip is the runtime reference pack. It has no production service behind it,
so it cannot establish external fidelity. Its historical fixture-based passes
also demonstrate why final-state and response-relationship assertions matter.
See [its recorded history](../packs/webclip/README.md).

The [existing review plan](review-fix-plan.md) remains relevant. Its F5 work
is reflected in the current scenario runner; verify current implementation
and acceptance evidence before reopening any historical item. This plan
extends that runner. Tool exposure and scheduled-study work in F6/F7 are not
prerequisites for the raw HTTP milestone.

## Scope and design constraints

- Start with raw HTTP, one world per environment, and serial operations.
- Reuse the gateway, behavior API, state store, evaluator, and evidence formats.
- Keep state, response evidence, semantic events, and deterministic counters
  transactionally consistent.
- Preserve old pack versions and historical scores. New semantics require
  explicit versions and compatibility checks.
- Keep world controls on a separate operator surface, unavailable to the
  participant unless the task explicitly grants access.
- Declare modeled operations and limitations. Unsupported behavior must produce
  an explicit diagnostic instead of plausible generated success.
- Defer broad integration coverage, hosted infrastructure, multi-service worlds,
  general event scheduling, and additional agent exposure modes.

## Delivery sequence

| Phase | Dependency | Deliverable |
| --- | --- | --- |
| P0 | None | Frozen scope and executable baseline |
| P1 | P0 | Standalone stateful serving through the shared runtime |
| P2 | P1 | Reset, checkpoint, fork, and explicit time controls |
| P3 | P1 | Portable behavioral corpus and target adapter |
| P4 | P2, P3 | Retry and failure scenarios with checked consequences |
| P5 | P3, P4 | One real-service workflow with bounded fidelity evidence |
| P6 | P5 | External pack authoring and a reviewable release candidate |

Each phase should be a reviewable change or small series of changes. Do not
remove public refusal guards or claim support before the corresponding
acceptance path works through the command-line interface (CLI).

## P0: Freeze scope and establish the baseline

Primary areas: `README.md`, `docs/capability-matrix.md`,
`docs/acceptance-mvp.md`, `packages/testkit`, and CLI integration tests.

1. Run the current scripted Webclip errand and preserve its pack identity,
   invocation, disposition, score, and semantic evidence as baseline evidence.
2. Identify which clock, fault, and idempotency primitives are actually wired
   into scenario execution. Record gaps without treating package-level tests
   as proof of end-to-end behavior.
3. Map acceptance criteria below to tests and documentation. Resolve conflicts
   with `SPEC.md` through explicit specification changes.
4. Record the selected P5 workflow: GitHub issue triage with the five operations
   and eight core cases in specification section 48.7. Recheck the pinned provider
   version before implementation. Documentation review does not count as a live pass.

Acceptance: the current stateful errand succeeds through the real local runner;
an incomplete scripted participant fails; the baseline names unsupported paths.
Paid agent runs are optional and do not establish infrastructure correctness.

## P1: Expose the shared scenario runtime through serve

Primary areas: `packages/runner/src/scenario-runtime.ts`,
`packages/behavior-runtime`, `packages/gateway`,
`apps/cli/src/handlers/serve.ts`, and associated CLI tests.

Extract environment lifecycle code from trial-specific orchestration into a
shared owner with package dependencies checked against existing boundaries.
Both `oal run` and standalone serving must use the same validation, transaction,
behavior timeout, state projection, and shutdown path.

Define the pack-based scenario invocation in the command registry and usage
documentation. Preserve the existing contract-mode invocation. Include pack and
scenario identities, seed, state revision, and capability information in the
environment manifest. Flush evidence and close child processes on shutdown.

Acceptance:

- A normal HTTP client completes create, list, render, extract, delete, and
  post-deletion read against standalone Webclip.
- The same seeded action sequence through serve and run has equivalent domain
  responses and state; observational timestamps and run IDs may differ.
- Invalid responses or failed transactions leave no partial domain mutation.
- The existing contract-mode workflow remains valid; shutdown releases the port
  and behavior child process.

## P2: Add explicit world lifecycle controls

Primary areas: `packages/state-store`, `packages/behavior-runtime`, shared
environment lifecycle code, `packages/evidence`, CLI command definitions, and
new versioned checkpoint metadata schemas.

Implement the control protocol and command signatures in specification section
48.3. Commands are inspect, checkpoint, reset, advance-time, and fork. Fork starts
a new process from a checkpoint; in-place restore is outside scope. These are
target interfaces, not existing supported commands.

A checkpoint must capture domain state and revision, virtual time, ID allocator
and random-stream positions, idempotency entries, fault-rule counters, required
blob references, and frozen pack/runtime identities. Include scheduled work if
the scoped runtime introduces it. A domain JSON snapshot alone is insufficient.

Create checkpoints only at a quiescent transaction boundary. Fork into an
independent world with its own evidence lineage and operator credentials.
Preserve deterministic response behavior from the checkpoint; scope evidence
identity by world even when domain IDs match across branches. Checkpointed data
must remain readable after the source process closes, including any encrypted
state needed for replay.

Reset creates a new recorded world generation from the declared baseline seed
and fixtures. Preserve previous evidence. Advance-time is monotonic within a
generation and explicitly logged; it must not depend on wall-clock sleeps.
Version mismatches or incomplete checkpoints fail before restoring any state.

Acceptance:

- Two forks given the same actions produce equivalent domain results.
- Different actions in one fork do not mutate its sibling or parent.
- A reset reproduces baseline behavior while preserving prior evidence.
- Restoring a checkpoint preserves the next ID, random choice, retry result,
  and time-dependent outcome, including after a process restart.
- Controls during an in-flight operation are serialized or explicitly refused.
- Participant HTTP requests cannot invoke operator controls.

## P3: Define a portable behavioral corpus

Primary areas: `schemas`, `packages/pack-ir`, `packages/pack`,
`packages/testkit`, `packages/evaluator`, and `packs/webclip`.

Add a versioned corpus format for setup, action sequences, response bindings,
assertions, and cleanup. Bind IDs from actual responses instead of replaying
recorded identifiers. Support assertions about response fields, resource
relationships, expected errors, and visibility after mutations. Define bounded
polling when the modeled service promises eventual rather than immediate
visibility.

Provide target adapters for the local emulator and a named service sandbox.
Black-box assertions must run against either target. Mark emulator-only state
and semantic-event assertions separately so hidden state cannot inflate a
cross-target fidelity claim. Normalize only explicitly declared nondeterministic
fields; never normalize away differences in resource relationships or outcomes.

Publish separate results for contract conformance, behavioral conformance, and
agent task success. Preserve existing `oal probe` semantics; a sequence harness
must not silently change the meaning of its historical reports.

Acceptance: the Webclip corpus passes its stateful backend and detects a
deliberately stateless or inconsistent test double. Cover create/list/read,
render/extract ordering, distinct resources, deletion, quota, and representation
negotiation. Include alternative valid orderings and negative paths, not just
one successful transcript.

## P4: Exercise retries, time, and failures

Primary areas: `packages/behavior-api/src/faults.ts`, scenario execution,
`packages/state-store` idempotency support, evidence schemas, and reference packs.

Wire only the bounded fault modes needed by the chosen workflow. Distinguish a
failure before a mutation from a lost response after a committed mutation.
Make that distinction observable to the operator without exposing privileged
state to the agent. Keep transport outcomes and domain commits consistent.

Test retries according to the modeled service's documented behavior. Do not
invent universal idempotency-key support. Where the service has no such
guarantee, duplicate creation or reconciliation may be the correct behavior.
Use a clearly labeled synthetic fixture to test generic runtime idempotency
mechanics when the real workflow does not exercise them.

Acceptance: a corpus detects duplicate effects where uniqueness is promised,
incorrect rollback after a lost response, and incorrect retry behavior. Seeded
faults reproduce across runs and forks. Time-bound behavior advances through
operator controls without sleeping. Reports distinguish expected service
failures, participant mistakes, and runtime failures.

## P5: Validate one real-service workflow

Primary areas: one new focused pack, its corpus and fidelity report, the target
adapter, and documentation. GitHub issue triage is the selected workflow; section 48.7 freezes its scope.

Implement only the operations and relationships needed for that workflow.
Use a dedicated disposable repository for live validation, environment-provided
credentials, and explicit opt-in writes. Setup and cleanup must be repeatable;
record any cleanup failure and the resources requiring removal.

For every behavioral claim, record the provider documentation source, API
version when available, corpus case, last verification date, and limitations.
Record whether it is documented, observed, synthetic, or unsupported. A single
live observation does not prove a general service guarantee.

Run the same black-box corpus against the emulator and service sandbox. Report
differences in transitions, visibility, errors, and retries. A missing live
credential is a skipped verification with a reason, never a fidelity pass.
Keep ordinary CI offline with local target doubles; run provider verification
as a separate opt-in job.

Acceptance: all declared core workflow cases pass both targets, or the release
scope is explicitly narrowed around documented deviations. A deliberately
incorrect emulator transition fails the corpus. The report bounds the claim to
the tested workflow, service version, and verification date.

## P6: Make packs independently authorable

Primary areas: `packages/behavior-api`, `packages/pack`, CLI authoring commands,
`docs/authoring-packs.md`, `docs/quickstart.md`, `README.md`, and package exports.

Replace repository-relative imports in the reference pack with a supported
authoring API. Freeze and identify the complete behavior dependency closure so
changes in helper modules cannot reuse an old behavior identity. Document
pack/runtime compatibility and reject incompatible versions explicitly.

Write a minimal external pack tutorial covering a state transition, semantic
event, corpus case, world reset, and agent rubric. Include a fidelity declaration
and modeled-operation list in the template. Agents can help author modules and
cases, but claims still require independent tests and provider evidence.

Acceptance: a pack outside this monorepo can validate, serve, run its corpus,
and execute a scripted participant using documented public imports. The
quickstart demonstrates branching and a real detected behavioral defect.
Capability documentation matches supported public commands.


## Implementation decisions

[SPEC.md section 48](../SPEC.md#48-stateful-environments-milestone) is authoritative
for the decisions below. This plan defines work order and completion evidence.

| Decision | Selected approach | Reason |
| --- | --- | --- |
| Runtime ownership | New `@oal/environment`; runner and serve both use it | Prevent behavior drift and avoid trial dependencies in standalone serving |
| Operator access | Authenticated private Unix socket; one shared serial queue | Keep controls outside the participant API and define transaction order |
| Checkpoints | Complete encrypted recovery bundle with a retained private key | Reproduce behavior after the source process and checkout are gone |
| Restore | Fork into a new world; exact compatibility checks | Preserve parent evidence and avoid implicit migrations |
| Corpus | Declarative versioned format; new `@oal/corpus` package | Make cases portable, inspectable, and usable without agent execution |
| Fault scope | Pre-behavior response, invalid candidate, post-commit disconnect | Test the distinct consequences of rollback and response loss |
| Provider | GitHub issue triage, pinned API version, eight fixed core cases | Bound the fidelity claim to a useful workflow |
| External authors | Public imports, frozen dependency closure, installable archives | Support generated packs without dependence on this repository layout |
| Acceptance | Separate stateful milestone map and readiness gate | Preserve historical acceptance and expose unfinished requirements |

Assume that artificial intelligence (AI) coding agents make new implementations
cheap. Verification and review remain necessary. Invest in stable schemas,
small tasks, reproducible failures, and independently authored cases. Do not add
a plugin framework, generated service catalog, or hosted control plane yet.

## Task contract and verification

Every task below starts as **pending**. Each row is one reviewable change; split
it further only when its acceptance evidence remains independently runnable.
The dependency column lists task IDs. Phase dependencies still apply.

For each task, record the commit, changed interfaces, exact verification command,
result, and artifact location in the acceptance map created by SE-P0-02. Mark a
task complete only when its named checks pass. A proposed test path is a file to
create, not evidence that a test already exists.

Use `pnpm exec vitest run <test paths>` for focused verification. Run
`pnpm run ci` after each phase. Tests must exercise the public command when a
command is the claimed feature. No paid agent calls are required. A provider
skip blocks fidelity completion but does not break ordinary offline CI.

The baseline artifact is `docs/evidence/stateful-baseline.v1.json`. Record the
repository commit, Node.js and pnpm versions, exact CLI arguments, pack version
and digest, seed, disposition, score, revision, semantic event names, and redacted
evidence digests. Store no private keys or credentials in that file.

### P0 tasks: baseline and acceptance

| ID | Depends on | Change and artifact | Completion check |
| --- | --- | --- | --- |
| SE-P0-01 | None | Run the existing scripted Webclip participant and failing control. Write the baseline artifact above. Inventory clock, IDs, randomness, faults, and idempotency as wired, package-only, or absent, with file references. | Run `pnpm exec vitest run apps/cli/src/run.test.ts packages/testkit/src/webclip-behavior.test.ts`. Also capture the literal `oal run` invocation and resulting evidence through the executable. Expected complete control: score 1, revision 6, six semantic events. Expected failing control: `agent_failed`, revision 0, no semantic events. Investigate any difference before updating expectations. |
| SE-P0-02 | SE-P0-01 | Add `tests/stateful-acceptance.map.json`, its schema, `tests/stateful-acceptance.test.ts`, and `scripts/stateful-readiness.mjs`. Add `pnpm run readiness:stateful`. Map every task ID to status, requirement section, tests, evidence, and remaining work. | Map tests reject missing IDs, nonexistent test titles, and completion without evidence. Readiness fails with pending or partial tasks and skipped required provider cases. Preserve the existing acceptance map and counts. |
| SE-P0-03 | SE-P0-02 | Promote AC-125's remaining isolation, seed replay, and backend failure checks to durable public-run tests in `apps/cli/src/run.test.ts`. Update only the acceptance claims those tests prove. | Two trials have independent state; repeated seeds have equivalent domain outcomes; an injected backend failure rolls back and cleans up. The incomplete participant stays failed. |

### P1 tasks: shared serving

| ID | Depends on | Change and artifact | Completion check |
| --- | --- | --- | --- |
| SE-P1-01 | SE-P0-03 | Create `packages/environment` and the frozen input interface from section 48.2. Move ownership from scenario-runtime; retain a thin runner adapter. Add package direction checks. | `packages/environment/src/environment.test.ts` proves startup, validation, projection, idempotent close, and child cleanup. Existing run tests pass. A forbidden runner import fails the boundary check. |
| SE-P1-02 | SE-P1-01 | Freeze the complete behavior dependency closure and execute frozen copies. Move Webclip imports to declared public packages. Include the closure and runtime identities in environment metadata. | `packages/pack/src/behavior-closure.test.ts` proves helper edits change identity, source edits after freezing cannot affect execution, and dynamic or escaping imports fail. Existing pack compatibility is explicit; no old digest is reused for new semantics. |
| SE-P1-03 | SE-P1-02 | Make deterministic services transaction-scoped. Persist committed positions and restore them after rollback. Add `environment.v1.schema.json` and manifest export. | Inject invalid response, invalid state, timeout, and database commit failure in `packages/environment/src/transactions.test.ts`. Each leaves state, IDs, and random positions unchanged; committed evidence and failure evidence remain distinguishable. |
| SE-P1-04 | SE-P1-03 | Implement pack-based scenario serve in command registry, handler, usage, and help. Keep contract serving valid. Add lifecycle evidence and shutdown handling. | `apps/cli/src/serve-scenario.test.ts` sends create/list/render/extract/delete/read requests with real HTTP. It compares serve and run using section 48.5 rules. Signal shutdown releases the port and child; contract serve tests pass. |

### P2 tasks: controls and recovery

| ID | Depends on | Change and artifact | Completion check |
| --- | --- | --- | --- |
| SE-P2-01 | SE-P1-04 | Define `checkpoint.v1.schema.json` and explicit export/import methods for clock, ID allocator, random streams, fault counters, and idempotency scope. Add transactional storage migrations before startup. | `packages/state-store/src/checkpoint.test.ts` checks full stream positions, next ID, replay entries, blobs, and incompatible versions. State-only snapshots and omitted components fail validation. |
| SE-P2-02 | SE-P2-01 | Implement the private socket, protocol routes, queue limits, credential checks, durable control IDs, and redacted control evidence. Add world inspect. | `packages/environment/src/control.test.ts` verifies queue order, stale generation, repeated and conflicting control IDs, overflow, and denied participant credentials. The data listener exposes no control routes. |
| SE-P2-03 | SE-P2-02 | Implement atomic checkpoint directories, private key retention, restore validation, and foreground `world fork`. Copy frozen inputs and required blobs. | `apps/cli/src/world-checkpoint.test.ts` closes the source process, removes its working directory, forks twice, and verifies the next ID, random draw, time, and synthetic replay entry. Sibling changes stay isolated. Corrupt metadata, missing keys/blobs, and interrupted writes fail before listener startup. |
| SE-P2-04 | SE-P2-03 | Implement reset and advance-time with generation checks, control result replay, preserved evidence, and baseline restoration. | `apps/cli/src/world-control.test.ts` verifies in-flight ordering, repeat-safe controls, monotonic time, overflow rejection, unchanged revision on advance, and baseline equivalence after reset. Retrying a reset control does not reset twice. |

### P3 tasks: corpus and reports

| ID | Depends on | Change and artifact | Completion check |
| --- | --- | --- | --- |
| SE-P3-01 | SE-P1-04 | Add corpus schema, optional manifest references, parser, typed bindings, assertion definitions, and bounded polling validation from section 48.5. Add valid and invalid golden files. | `packages/pack/src/corpus.test.ts` accepts old packs and valid corpus files. It rejects forward bindings, duplicate step IDs, unsupported operators, unbounded polling, and scripts. |
| SE-P3-02 | SE-P3-01 | Create `@oal/corpus`, local target, target interface, `corpus-report.v1.schema.json`, and public validate/run commands. Separate contract, behavior, and agent result fields. | `apps/cli/src/corpus.test.ts` runs through real HTTP, binds returned IDs, records each poll, fails missing bindings, and always attempts eligible cleanup. Hidden-state cases cannot pass as black-box results. Probe regression tests pass. |
| SE-P3-03 | SE-P3-02 | Add Webclip corpus cases for lifecycle, ordering, independent resources, deletion, quota, and content negotiation. Add alternative interleavings and negative doubles. | `packages/testkit/src/webclip-corpus.test.ts` passes the stateful backend and fails stateless, repeated-ID, swapped-resource, ignored-deletion, and wrong-representation doubles. Each defect maps to a specific failed assertion. |

### P4 tasks: faults and time

| ID | Depends on | Change and artifact | Completion check |
| --- | --- | --- | --- |
| SE-P4-01 | SE-P2-04, SE-P3-03 | Version fault phases and wire the three fixtures from section 48.6. Persist fault consumption and distinguish committed response from transport delivery. | `packages/environment/src/faults.test.ts` checks no mutation before behavior, rollback for invalid candidates, committed mutation after response loss, and unknown delivery after a crash. Unsupported actions fail preflight. |
| SE-P4-02 | SE-P4-01 | Add a labeled synthetic runtime pack for idempotency and virtual expiry. Extend checkpoint tests to cover real wired faults and replay. | `packages/testkit/src/runtime-corpus.test.ts` covers replay, conflict, principal separation, expiry without sleeping, and lost response. The same fault sequence reproduces after restart and in both forks. |
| SE-P4-03 | SE-P4-02 | Add duplicate-effect and incorrect-rollback doubles. Complete error classifications and operator evidence in corpus reports. | Corpus detects both defects. Report tests distinguish expected service errors, assertion failures, provider failures, and runtime errors. A lost response never becomes evidence of rollback. |

### P5 tasks: provider fidelity

| ID | Depends on | Change and artifact | Completion check |
| --- | --- | --- | --- |
| SE-P5-01 | SE-P3-03, SE-P4-03 | Build `packs/github-issue-triage` with the five operations, eight cases, capability limits, sources, and `fidelity.v1` claims. Recheck API version and pin expected endpoint statuses before implementation. | `packages/testkit/src/github-corpus.test.ts` passes all local core cases. A wrong close transition fails. Tests preserve issue number versus ID and ignore pull requests in list assertions. |
| SE-P5-02 | SE-P5-01 | Implement the GitHub target with explicit writes, repository/token preflight, serial bounded requests, run markers, and cleanup ledger. Add an opt-in verification job. | `packages/corpus/src/github.test.ts` uses local HTTP doubles to check credentials, version headers, pagination, rate-limit waits, uncertain creation, and cleanup failure. No write is retried automatically. Ordinary CI needs no token. |
| SE-P5-03 | SE-P5-02 | Run the same eight black-box cases on the dedicated repository. Save redacted corpus and fidelity reports with provider version, dates, sources, digests, limitations, and cleanup results. | All eight cases pass on both targets; every created resource is accounted for and cleanup succeeds. Missing credentials remain a recorded skip and block completion. Resolve deviations through an explicit specification amendment. |

### P6 tasks: external authors and release candidate

| ID | Depends on | Change and artifact | Completion check |
| --- | --- | --- | --- |
| SE-P6-01 | SE-P5-03 | Complete public authoring exports and compatibility checks. Produce installable archives for the CLI and its required packages. Reuse the frozen dependency closure from SE-P1-02. | `packages/pack/src/behavior-closure.test.ts` detects helper edits and rejects dynamic or escaping imports. `tests/external-pack.test.ts` installs archives outside the workspace and resolves only public imports. |
| SE-P6-02 | SE-P6-01 | Add an external pack template and tutorial with one transition, semantic event, corpus, reset, fork, rubric, and fidelity declaration. Update quickstart and capabilities only for proven commands. | The external fixture validates, serves, executes its corpus, forks, and runs a scripted participant. A deliberately broken transition fails the corpus. Tutorial commands use the installed executable. |
| SE-P6-03 | SE-P6-02 | Run phase and milestone gates. Record a practitioner trial with an agent developer and a service maintainer. Prepare release artifacts and limitations without publishing. | `pnpm run ci` and `pnpm run readiness:stateful` pass. Record setup effort, a reproduced defect, fork replay, corpus result, and unresolved limitations. The release candidate includes the live report and installable artifacts. |

P2 and P3 can proceed independently after P1. P6 package work can be prepared
earlier, but P6 completion depends on P5. Human trials and live credentials are
external dependencies; report them explicitly instead of inventing evidence.

## Validation and completion

For each implementation phase, run focused package and CLI integration checks,
then the repository's required `pnpm run ci` gate. Update the acceptance map and
capability claims only after the public execution path passes. Preserve existing
historical evidence rather than rewriting it to match new rubrics.

The first release candidate is complete when:

1. A user can launch a stateful pack independently of the agent runner.
2. Reset, fork, and time controls preserve the defined deterministic semantics.
3. The same versioned behavioral corpus works with local and service targets.
4. One narrow real-service workflow has explicit, dated fidelity evidence.
5. Agent scores remain distinguishable from emulator correctness results.
6. An external author can build and validate a pack from the documentation.

Use a practitioner trial after those gates: ask an agent developer and a service
maintainer to reproduce a defect, fork the environment, and rerun the corpus.
Record setup effort, missing behavior, and whether the corpus catches a defect
their existing mocks miss. Use those observations to decide whether to deepen
the workflow or add another integration.

## Positioning and principal risks

Lead with reproducible API worlds, checked behavior, and inspectable agent
outcomes. LocalStack's [September 14, 2026 acquisition announcement](https://www.globenewswire.com/news-release/2026/09/14/3361421/0/en/localstack-acquires-wondertwin-ai-to-let-developers-and-ai-agents-build-integrations-locally.html)
supports treating broad application emulation as an established competitive
category. This plan tests a narrower differentiation; it does not assume demand.

The main risks are an internally consistent but inaccurate model, incomplete
checkpoints, implementation-specific assertions that cannot run against a live
service, and drift between serve and run. Address them through the shared
runtime, complete checkpoint semantics, cross-target corpus, and bounded
fidelity claims. Delay integration breadth until the first workflow demonstrates
those properties.
