# Plan to address the project review

Status: proposed. This document plans implementation; it does not mark any fix
complete.

The second review confirms six findings. This plan groups their fixes into seven
work packages. Correct results and capability claims first. Then complete the
advertised execution paths.

The plan keeps the contract/scenario distinction and the existing raw HTTP path.
It does not assume that package count or the dependency policy proves a defect.
All acceptance controls use scripted participants and local services. Paid model
runs are not required to establish correctness.

| Work package | Priority | Depends on | Result |
| --- | --- | --- | --- |
| F1: Claims and acceptance | 1 | None | Published status matches demonstrated behavior. |
| F2: Bounded pattern execution | 1 | None | Contract patterns cannot stall the controller. |
| F3: Analysis correctness | 1 | None | Supported plans execute as declared; censored slots count once. |
| F4: Webclip grading | 1 | None | Incomplete errands cannot receive full credit. |
| F5: Scenario execution | 2 | F2, F4 | A stateful webclip task passes through the real runner. |
| F6: Tool execution | 2 | F2, F5 | The same task works through each advertised exposure. |
| F7: Scheduled study execution | 2 | F3, F5 | A locked study launches, persists, and analyzes real child trials. |

F1 through F4 can proceed in parallel. Coordinate F2 and F5 because both affect
the gateway execution boundary. F6 and F7 can proceed in parallel after their
dependencies. Keep missing workflows explicitly unavailable until their own
acceptance checks pass.

**F1: Correct capability claims and the acceptance gate.**

Update `README.md`, `docs/usage.md`, `docs/research-methods.md`, and
`docs/capability-matrix.md`. Distinguish working raw HTTP execution, implemented
components, and workflows that the command-line interface rejects. Correct the
webclip repair claim to describe only the observations that its recorded
evidence supports.

Revise `tests/acceptance.map.json`, `tests/acceptance.test.ts`, and
`docs/acceptance-mvp.md`. Separate a correction to a requirement from an
unimplemented requirement. Correcting the Steel operation count can satisfy the
revised requirement. Deferring its stateful behavior cannot.

Generate the coverage counts from the map. Keep map consistency checks separate
from product readiness. The continuous integration gate can verify an honest
incomplete map. A release readiness check must fail while required behavior is
missing. Record explicit acceptance dependencies for F2 through F7; do not weaken
required outcomes to make the gate pass.

Acceptance: unsupported commands and their documentation agree. The report shows
covered, corrected, partial, and missing requirements separately. A constructed
trace cannot satisfy a criterion that requires a live successful task.

**F2: Bound every execution path that evaluates untrusted patterns.**

Use a shared asynchronous worker boundary for schema work supplied by a contract
or pack. Keep the deadline and worker termination in the parent process. Bound
the queue, message sizes, and worker resources. Cache compiled schemas within the
worker so normal requests do not start a new worker each time.

Apply the boundary to request validation, response validation and generation,
participant reports, and rubric schema checks. Inventory other pack-supplied
patterns, including cue and redaction rules. Apply the same bounded execution
policy where these evaluate untrusted text. Audit `patternProperties` as well as
`pattern`.

The main files are `packages/core/src/schema/validator.ts`,
`packages/gateway/src/validate.ts`, `packages/gateway/src/response-body.ts`,
`packages/gateway/src/pattern.ts`, `packages/gateway/src/generate.ts`,
`packages/runner/src/exposure.ts`, and the evaluator call sites. Add resource
settings and stable diagnostics through `packages/config` and `packages/core`.

Preserve the current expression semantics for work that completes within the
budget. A timeout produces an explicit infrastructure outcome and no state
mutation. It must not become a valid response or an ordinary task failure.
Terminate the worker and release queued work under the declared failure policy.
Record the event in the trial evidence.

Do not use a regular-expression heuristic as the safety boundary. A timer inside
the blocked worker cannot enforce the deadline. Do not leave a synchronous
untrusted path available as a fallback.

Acceptance: run the observed pattern through `oal serve --strict`. With a short
configured worker deadline, the hostile request terminates within a bounded test
deadline. The controller and an unrelated request remain responsive. Verify
worker cleanup, bounded repeated attacks, and later valid requests. Repeat the
check through request parameters, response generation, and report evaluation.
Preserve existing schema and deterministic response tests. Measure worker
overhead against the repository performance budgets.

**F3: Enforce supported analysis and preserve one outcome per slot.**

First, add a shared analysis support check in `packages/study`. Call it during
study validation, planning, analytical preflight, and `analyzeStudyRun`. Keep
archived plan parsing distinct from permission to execute an analysis.

The initial supported calculation remains the implemented binary risk
difference with Wilson and Newcombe intervals. Reject `risk_ratio`, generic
`difference`, and Wald options before analytical execution. Do not substitute
methods. Return a stable diagnostic that names the unsupported option. Add these
methods later only with their own statistical specification and reference tests.

Audit every accepted analysis field against its implementation. Enforce or reject
weighting, population, eligibility, floor/ceiling rules, and comparison-family
options. Verify that the primary outcome matches its referenced contrast. Reject
ambiguous contrasts with multiple cells per side until marginal analysis exists.
Do not silently choose the first matching cell or clamp a registered setting.
Reject overlapping comparison families until their execution is defined. Reject
`--analysis-plan` while the command only reads the file without executing it.

Second, compute main and sensitivity outcomes from the same slot resolution.
Use `packages/report/src/aggregate.ts` as the source of replacement-chain facts.
For sensitivity, an earlier post-control censor gives that slot one failure,
even when a later replacement passes. Otherwise, use the eligible slot outcome.
A chain with only pre-control failures contributes no invented task failure.
Track remaining unresolved slots explicitly under the registered policy.

Apply the same slot rule to ordinary report aggregation. Its existing sensitivity
test expects `2/3` where the specified result is `1/2`. Replace that expectation
with an independently calculated slot table. Sharing resolution facts must not
leave separate, contradictory counting rules in the report and study packages.

Build sensitivity independently from main-estimate drafts. A refused main
estimate must not automatically erase an estimable sensitivity result. When
remaining slots also prevent sensitivity estimation, record that reason.

Acceptance: a plan requesting a risk ratio fails support validation; it never
returns a difference. Four passing main slots with one censored original and a
passing replacement produce the specified sensitivity difference of `-0.5`.
Cover censored primaries, censored replacements, pre-control-only chains, unused
reserves, zero denominators, and both contrast directions. Check each expected
count by hand and assert that each primary slot contributes at most once.

Run the analysis through `oal study analyze` using a fixture with real frozen
files and matching hashes. Include changed-plan and changed-evidence rejection.
The fixture need not wait for study launch integration. Record the executing
analyzer identity. Corrected analysis of old evidence creates a derived result;
it does not overwrite the original analysis.
Provide an explicit derived-result path for corrected built-in analysis without
pretending to support arbitrary analysis-plan files. Future analytical runs use
new protocol versions and locks where the frozen implementation changes.

**F4: Make webclip grading match its task.**

Map each task requirement to a required rubric check. Verify two distinct clip
identifiers, the requested URLs and formats, both renders, both content reads,
markdown extraction, scoped deletion, the quota read, and agreement with the
participant report. Verify the response representation and the explicit request
for it. Do not depend on header array positions.
Allow valid interleaving of the two clip lifecycles. Require ordering only where
the task or resource behavior requires it, including the quota read after
deletion.

Add a bounded normalized header view or a narrow header predicate to evaluation.
Test header ordering, case, and multiple Accept values. Record any change to
evaluator semantics in implementation provenance.

Keep the report schema able to represent failure honestly. Interpret its values
in the rubric. Keep free-text answers available as descriptive evidence. Remove
the word-matching comprehension check from the task completion score; a vocabulary
match does not establish understanding.
Permit an empty uncertainty list instead of requiring participants to invent one.

Treat successful create-call count as evidence about requests, not proof of two
resources. Do not silently turn an undeclared efficiency preference into task
failure. If exactly two create calls remain required, state that constraint in
the task. Otherwise record extra calls as a separate diagnostic.

The main files are under `packs/webclip/tasks`, `packs/webclip/evals`, and
`packs/webclip/schemas`, plus `packages/testkit/src/webclip-pack.test.ts`.

Acceptance: removing each required step separately fails the task. Also fail
duplicate identifiers, swapped formats or URLs, the wrong deleted clip, incorrect
representations, and reports that contradict the evidence. A complete trace
passes. The two review probes become permanent negative controls.

Version the corrected pack and rubric. Keep old evidence and scores under their
original versions. Label any regrading as derived. The current static fixtures
cannot satisfy the corrected full errand; show that limitation until F5 passes.
Do not relax the new rubric to retain the old pass rate.

**F5: Connect scenario execution and prove a live stateful task.**

Refactor the gateway into one shared asynchronous request path. Keep parsing,
authentication, validation, tracing, and response serialization common to
contract and scenario modes. Connect `BehaviorModuleHost`,
`executeBehaviorRequest`, and the state store through the existing public package
interfaces.

Add a child bootstrap that loads the pack's declared entrypoint and export.
Freeze and hash executable inputs before launch. Check operation coverage and
backend compatibility. Label the existing local behavior profile accurately;
starting a child process does not establish network or filesystem isolation.
Bind scenario and behavior identities to frozen content rather than mode names.

Commit state and semantic events only after validation succeeds. Preserve ingress
order, deterministic services, rollback, and cleanup. Wire the final snapshot
and projection into the runner. Replace the unconditional empty final state only
when a real scenario snapshot exists. Remove scenario refusal guards only after
this path passes integration tests.

Implement webclip's eight operations with request-dependent state. Creation
returns distinct identifiers and preserves URL and format. Rendering changes
status. Content and extraction depend on state and the requested representation.
Deletion removes the selected resource. Quota derives from remaining resources.
All content is local synthetic fixture data; no URL is fetched.

Acceptance: a scripted participant completes the corrected webclip task through
the public run command. It reads returned identifiers and sends real Accept
headers. It must not guess fixture identifiers. Check trace, report, final state,
and score together. Run another trial to prove isolation. Repeat the same seeded
request sequence to prove deterministic behavior. Inject a backend failure and
verify rollback and cleanup. Also retain a failing scripted participant.

Use a small generic stateful backend in runner tests. Keep webclip semantics in
the pack and its test kit. Do not hard-code them in the runner.
This milestone does not establish Steel checkpoint or streaming parity. Keep
those original acceptance criteria partial until their own live controls pass.

**F6: Connect direct and catalog tools to the same execution path.**

Connect the existing tool components to F5's gateway path. Add per-trial Model
Context Protocol (MCP) transport, endpoint delivery, and lifecycle handling. Pass
the endpoint through the exposure descriptor to adapters. Extend the generic
scripted adapter control first, then the Codex adapter configuration.

All invocations must use the same authentication, limits, state transitions,
response validation, and trace rules as raw HTTP. Carry media selection, including
Accept, through the invocation envelope. If an operation cannot be represented,
report that limitation before the participant starts.

Acceptance: complete the same webclip task over raw HTTP, direct tools, and
catalog tools. Compare semantic outcomes and final state. Permit documented
transport differences. Test discovery, invalid calls, cancellation, and endpoint
cleanup. An adapter without tool support fails preflight with an accurate reason.

**F7: Connect scheduled assignments to durable trial execution.**

The scheduler owns assignment identifiers, run identifiers, seeds, ordering, and
replacement activation. The runner owns trial lifecycle, per-trial services, and
child-batch evidence. Add a public runner execution interface that accepts and
validates the scheduler's bindings. Ordinary batches use the same interface with
their locally derived bindings.
Separate opening a child batch, executing one assignment, and finalizing the
batch. Multiple interleaved assignments must share that batch without reopening
or overwriting it.

Connect `executeStudyRun` through its `TrialExecutor` interface. Persist frozen
inputs and the phase lock before the first launch. Add awaited assignment-ledger
appends before launch and after each terminal outcome. Keep one authoritative
assignment ledger; child evidence references its assignments. Do not reconstruct
an execution ledger only after all trials finish.

Respect the paid-call ceiling, cancellation, held replacements, and slot mapping.
Preserve the existing confirmation behavior for actual paid launches. A dry run
starts no participant and persists no study evidence. Remove the command's
unconditional refusal only when this path works.

Acceptance: validate, lock, schedule, run, and analyze a two-cell study through
the public commands using scripted participants. Verify frozen identifiers,
seeds, digests, cell membership, and one denominator entry per slot. Include a
declared corrupt-evidence replacement, interruption, and an assignment that never
starts. Ensure intact task failure cannot trigger replacement. A crash leaves a
readable ledger and no implicit duplicate launch. The resulting analysis must
pass the real hash-verification path from F3.

**Completion and validation policy.**

Use separate reviewable changes for each work package. F2 and F3 may need smaller
changes for their shared boundaries and regression controls. Run focused checks
while implementing each change, then run `pnpm run ci` before integration.

Update F1's capability and acceptance records only when the corresponding public
workflow passes. Product readiness remains incomplete while any required outcome
is missing. Preserve existing evidence throughout the work. Do not publish a new
version or rerun paid experiments as part of implementing this plan.
