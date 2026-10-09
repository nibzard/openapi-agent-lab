# Stateful API environments implementation plan

Status: proposed; no implementation work is marked complete by this plan.
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
acceptance path works through the CLI.

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
4. Set the reference workflow scope for P5. The proposed default is GitHub issue
   triage: create an issue, read it, list it, label it, and close it. Confirm
   endpoint semantics from current provider documentation before implementation.

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

Specify the control API and CLI before exposing commands. Proposed operations
are reset, checkpoint, fork, inspect, and advance-time; exact command spelling
is an implementation decision, not an existing supported interface.

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
adapter, and documentation. GitHub issue triage is the initial candidate from P0.

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
