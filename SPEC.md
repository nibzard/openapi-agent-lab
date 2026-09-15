# OpenAPI Agent Lab

Implementation specification for a general-purpose OpenAPI mock, agent test
harness, and evaluation system.

| Field                    | Value                           |
| ------------------------ | ------------------------------- |
| Product name             | OpenAPI Agent Lab               |
| CLI executable           | **oal**                         |
| Document status          | Implementation specification    |
| Specification version    | 0.2                             |
| Date                     | 2026-08-27                      |
| Reference implementation | TypeScript, Node.js 24 LTS, ESM |
| Initial deployment       | Local CLI                       |
| First high-fidelity pack | Steel Computer                  |

This document is normative. The terms MUST, MUST NOT, SHOULD, SHOULD NOT, and
MAY have their usual requirements meaning. When this document conflicts with an
example, the prose requirement wins. When two requirements appear to conflict,
the more security-preserving and more explicit behavior wins until this
specification is amended.

## 1. Executive summary

OpenAPI Agent Lab turns an OpenAPI document into a deterministic environment
where an AI agent can discover, call, and be evaluated against an API without
contacting the production service.

The product has two fidelity layers:

1. **Contract fidelity.** Given only an OpenAPI document, the lab compiles
   routes, authentication requirements, parameter serializers, validators,
   examples, response generators, HTTP or MCP exposure, and normalized evidence.
   It can validate and synthesize contract-valid interactions. It does not claim
   to reproduce business behavior.
2. **Scenario fidelity.** An optional versioned pack adds fixtures, state
   transitions, idempotency, faults, prompts, tasks, Arazzo workflows, result
   schemas, and deterministic rubrics. This is how the lab represents lifecycle
   and side-effect semantics that OpenAPI cannot express.

The same API execution engine serves three agent exposure treatments:

- Raw HTTP with an explicit file, discoverable-documentation, tool-only, or
  no-complete-contract visibility treatment.
- One generated tool per operation for small contracts.
- Three discovery tools—search, describe, and invoke—for large contracts.

The same run engine supports one trial, a homogeneous cohort, or an optional
preregistered multi-cell study. Every launched trial freezes its inputs,
isolates the participant workspace, starts a per-run mock, captures every
accepted and rejected request, validates the participant report, grades trace
and final state, and retains failed, timed-out, malformed, zero-request, and
interrupted outcomes. Study mode additionally retains unstarted primary
assignments and held replacements and freezes its factors, assignment schedule,
replacement rules, estimands, and analysis plan before analytical participant
execution begins.

The project generalizes the existing Steel Computer experiment. Steel becomes
the first built-in high-fidelity scenario pack rather than remaining hard-coded
in the server, runner, and analyzer.

## 2. Product promise and limits

The short product promise is:

> Supply a local OpenAPI 3.0 or 3.1 document, get a safe deterministic mock an
> agent can use, and optionally attach a pack that turns interactions into a
> reproducible evaluation.

“Works with any OpenAPI document” has a precise meaning:

- The compiler MUST accept bounded OpenAPI 3.0.x and 3.1.x JSON or YAML inputs.
- Every parsed HTTP operation MUST appear in the intermediate representation and
  capability report.
- Each operation MUST be labeled supported, approximated, requires-scenario, or
  unsupported with stable reasons.
- The system MUST never silently discard a construct or claim high-fidelity
  behavior it cannot provide.
- Strict runs MUST fail before an agent starts if an operation or feature
  required by the selected task is unsupported.

It does not mean:

- Arbitrary business logic can be inferred from schemas.
- Callbacks, webhooks, payments, browsers, command execution, email, SSH, cloud
  resources, or URL ingestion perform real-world side effects.
- The mock is suitable as a production emulator.
- Every OpenAPI feature is implemented at equal fidelity in the first release.

## 3. Problem statement

The Steel prototype proves that an agent can be tested against a local,
traceable API without giving it a production credential. It also reveals the
boundaries that prevent the current implementation from accepting arbitrary
specifications:

- The mock parses routes from OpenAPI but requires one handwritten handler for
  every operation ID.
- The state model, authentication behavior, lifecycle rules, trace fields, task
  rubric, and diagnostic signals are Steel-specific.
- The runner hard-codes participant files, prompt layout, environment names, and
  one agent CLI.
- The analyzer hard-codes a single ordered recovery task.
- Contract, mock behavior, prompt treatment, and concurrency treatment are not
  first-class experiment variables.
- Contract-only mocks can produce valid payload shapes but cannot infer resource
  lifecycle, persistence, ownership, or side effects.
- Large specifications can contain hundreds or thousands of operations, making
  one tool per operation impractical.

The generalized product must preserve the prototype’s strongest properties while
separating generic mechanisms from API-specific policy.

## 4. Goals

### 4.1 Functional goals

The product MUST:

- Accept local OpenAPI 3.0.x and 3.1.x documents in JSON or YAML.
- Resolve same-pack local references safely and deterministically.
- Emit one canonical ContractIR used by every downstream subsystem.
- Produce a machine-readable capability report before server or agent startup.
- Start a deterministic local HTTP mock without handwritten handlers for
  contract-supported operations.
- Support high-fidelity stateful behavior through versioned scenario packs.
- Validate requests and mock responses against the compiled contract.
- Emulate declared authentication semantics with synthetic per-run credentials.
- Expose operations over raw HTTP, direct tools, or catalog tools.
- Support prompt sets, task templates, participant instructions, final-output
  schemas, and hidden deterministic rubrics.
- Accept hidden or participant-visible Arazzo workflows.
- Run isolated trials and homogeneous cohorts through pluggable agent adapters.
- Ship reference adapters for Codex CLI and a generic argv-based command.
- Freeze and hash all effective inputs and implementation versions.
- Capture every request reaching the gateway, including rejected and unmatched
  requests.
- Grade primarily from normalized trace, final state, artifacts, and structured
  final output.
- Keep setup, provider, infrastructure, agent-execution, and task-evaluation
  outcomes distinct.
- Generate canonical JSON reports plus terminal and Markdown projections.
- Migrate Steel as the first golden scenario pack with behavioral parity.
- Support optional versioned StudyProtocols for blinded, balanced, multi-cell
  research without complicating ordinary single-run use.
- Distinguish intended treatment differences from accidental implementation,
  participant-surface, or runtime drift.
- Refuse unregistered inferential pooling while retaining explicitly labeled
  descriptive comparisons.

### 4.2 Quality goals

The product MUST be:

- Deterministic below the model boundary for the same frozen inputs, seed, and
  request order.
- Explicit about approximations and unsupported behavior.
- Safe by default with no production network or host side effects.
- Reproducible through immutable, content-addressed evidence.
- Extensible without coupling core packages to Steel.
- Testable without paid model calls.
- Observable without creating undeclared participant-facing endpoints.
- Usable from a local CLI before a hosted product or web UI exists.

## 5. Non-goals

The initial release will not implement:

- Swagger or OpenAPI 2.0 conversion.
- OpenAPI 3.2 execution.
- AsyncAPI, GraphQL, gRPC, Smithy, or WebSocket APIs.
- A transparent proxy or record/replay proxy to production.
- Real upstream credentials.
- Automatic inference of business state machines.
- Real callbacks or webhook delivery.
- Real URL fetching, SSH, browser, email, payment, command, container, or cloud
  side effects.
- Public internet mock hosting.
- A multi-tenant control plane.
- A browser UI.
- Distributed scheduling.
- Long-term artifact hosting.
- Arbitrary untrusted JavaScript inside the safe default runtime.
- A model judge as the sole or primary pass/fail oracle.
- Load testing or comprehensive property-based API fuzzing as the product’s main
  purpose.
- Automatic invention of hypotheses, estimands, exclusion rules, sample sizes,
  causal claims, or API-variant equivalence.
- Treating a lexical cue scan, contract diff allowlist, or shared backend digest
  as proof that two treatments are scientifically equivalent.

These capabilities may be designed later as explicitly named modes. They MUST
NOT silently change the semantics or security of a baseline run.

## 6. Users and primary journeys

### 6.1 API developer: inspect and start a contract mock

```sh
oal inspect ./openapi.json
oal serve ./openapi.json --port 4010 --run-seed 42
```

The first command explains what will and will not work. The second exposes
supported operations on loopback and writes evidence to a new manual-run
directory.

### 6.2 Pack author: add behavior

```sh
oal pack init ./github-lab --openapi ./github-openapi.yaml
oal pack validate ./github-lab --strict
oal serve ./github-lab --mode scenario --scenario empty-account
```

The author supplies only semantics that are not derivable from OpenAPI: initial
state, transitions, ownership, idempotency, faults, or side-effect stand-ins.

### 6.3 Eval author: define a task

```sh
oal eval init ./github-lab --id create-issue-and-label
oal eval validate ./github-lab --eval create-issue-and-label
oal run ./github-lab \
  --eval create-issue-and-label \
  --agent codex-cli \
  --model MODEL_ID \
  --effort high \
  --count 1
```

Validation MUST complete before a paid agent process starts.

### 6.4 Researcher: run a cohort

```sh
oal run ./packs/steel-computer \
  --eval checkpoint-recovery \
  --agent codex-cli \
  --model MODEL_ID \
  --effort high \
  --exposure raw-http \
  --count 10 \
  --parallel 1 \
  --batch steel-baseline-01
```

For cohorts larger than one, adapter, agent version, model, effort, exposure,
contract visibility, prompt set, task version, pack version, scenario,
evaluator, limits, and parallelism MUST be pinned in the effective run profile.

### 6.5 Researcher: report and compare

```sh
oal report .oal/runs/steel-baseline-01
oal report .oal/runs/steel-baseline-01 --format json --out analysis.json
oal compare .oal/runs/steel-baseline-01 .oal/runs/steel-catalog-01
```

Reports MUST keep zero-request, timed-out, agent-failed, malformed-report, and
infrastructure-invalid trials visible.

### 6.6 Researcher: preregister and run a multi-cell study

```sh
oal study validate ./studies/api-shape-v1 \
  --phase pilot \
  --pack ./packs/workspace-service \
  --check-lock
oal study schedule ./studies/api-shape-v1 \
  --phase pilot \
  --seed pilot-fixed-seed \
  --study-run api-shape-pilot-01 \
  --out ./assignments.json
oal study run ./studies/api-shape-v1 \
  --phase pilot \
  --pack ./packs/workspace-service \
  --schedule ./assignments.json \
  --model MODEL_ID \
  --effort high \
  --study-run api-shape-pilot-01
oal study analyze .oal/studies/api-shape-pilot-01
```

Validation freezes the research question, factor matrix, participant surfaces,
eligibility and replacement rules, primary comparisons, statistical methods, and
interpretation limits before any analytical paid call. A StudyRun may interleave
assignments across cells while each child batch remains homogeneous.

### 6.7 Adapter developer

An adapter developer implements the agent adapter interface and runs the adapter
conformance suite. Adapters translate a normalized run context into one agent
CLI or SDK. They do not implement contract parsing, mocking, participant
workspace construction, evidence layout, or grading.

## 7. Terminology

| Term                   | Definition                                                                                                                                                |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source document        | Original OpenAPI bytes supplied by the operator.                                                                                                          |
| ContractIR             | Immutable normalized representation of the complete parsed contract.                                                                                      |
| Capability report      | Per-document and per-operation support assessment with stable diagnostics.                                                                                |
| Contract backend       | Deterministic example/schema response generator with no claimed business semantics.                                                                       |
| Behavior backend       | API-specific scenario implementation operating on serializable state.                                                                                     |
| Pack                   | Versioned bundle containing a contract plus optional behavior, fixtures, prompts, tasks, workflows, schemas, and rubrics.                                 |
| Scenario               | Named initial state, configuration, and deterministic fault schedule in a pack.                                                                           |
| Eval                   | One task, result schema, prompt selection, scenario, and rubric.                                                                                          |
| Run profile            | How an eval is executed: adapter, model, effort, exposure, limits, sandbox, count, and parallelism.                                                       |
| Trial                  | One agent attempt with its own workspace, mock, credential, state, and evidence.                                                                          |
| Batch                  | Immutable homogeneous set of scheduled trials.                                                                                                            |
| Cohort                 | Evaluated trials grouped for aggregate reporting.                                                                                                         |
| StudyProtocol          | Optional versioned preregistration of a research question, factors, phases, assignment rules, estimands, exclusions, analysis, and interpretation limits. |
| PhasePlan              | Immutable plan for one study phase, including analytical status, assignments, replacement capacity, stopping rules, and paid-call ceiling.                |
| StudyRun               | Immutable parent execution that schedules trials across two or more homogeneous child cell batches according to one PhasePlan.                            |
| Factor                 | Declared experiment dimension whose levels are the only intended differences between compatible cells.                                                    |
| Cell                   | One fully resolved combination of factor levels and all constant execution inputs.                                                                        |
| Assignment             | Frozen primary or held replacement slot linking a cell, block, repetition, and eventual trial identity.                                                   |
| ContractVariant        | Frozen effective contract derived from an immutable base through an allowlisted static or deterministic transformation.                                   |
| Participant surface    | Complete set of bytes, names, routes, metadata, credentials shapes, errors, and tools observable by the participant.                                      |
| Documentation plane    | Explicit participant-visible contract-discovery facade, separate from product operations and private control mechanisms.                                  |
| Terminal disposition   | Exhaustive research classification derived from lifecycle stages, process outcome, operator signals, and evidence integrity.                              |
| Evidence integrity     | Whether required evidence is intact, corrupt, or missing, recorded independently of execution and task outcome.                                           |
| Compatibility key      | Digest proving which non-treatment inputs and implementation conditions must match before inferential pooling.                                            |
| Estimand               | Preregistered quantity a study intends to estimate, including population, outcome, contrast, denominator, and weighting.                                  |
| Participant            | The tested agent and any commands it launches.                                                                                                            |
| Control plane          | Runner, private state, evaluator, and artifact management unavailable to the participant.                                                                 |
| Data plane             | Agent-visible HTTP or MCP operations derived from the contract.                                                                                           |
| Documentation exchange | Request to a protocol-declared documentation route; onboarding evidence that is never counted as a product API operation.                                 |
| Exposure mode          | raw-http, direct-tools, or catalog-tools.                                                                                                                 |
| Contract visibility    | file, discoverable, tool-only, or none.                                                                                                                   |
| Workflow visibility    | hidden or participant.                                                                                                                                    |
| Normalized trace       | Ordered, redacted, transport-neutral record of API exchanges.                                                                                             |
| Infrastructure-invalid | A trial whose evidence cannot support task evaluation because setup, provider, runner, mock, persistence, or evaluator failed.                            |

## 8. Locked product decisions

These decisions are normative for the implementation sequence in this
specification and should not be reopened without an explicit specification
change.

1. **Contract and scenario fidelity are distinct.** Contract mode never claims
   business fidelity.
2. **One compiler owns interpretation.** The gateway, tools, generator,
   evaluator, and reports consume ContractIR rather than separately parsing
   OpenAPI.
3. **Every source operation remains visible.** Unsupported features become
   explicit capability outcomes.
4. **Strict preflight precedes paid work.** Pack, contract, adapter, prompt,
   workflow, and rubric validation finish before an agent starts.
5. **The server is per trial.** State, credentials, port, trace, and virtual
   time are never shared across trials.
6. **The participant has no admin API.** Readiness, reset, state inspection,
   fixtures, health, and grading are private control-plane mechanisms.
7. **Evidence is append-only or write-once.** Existing batch and trial paths are
   never overwritten.
8. **Primary grading is deterministic.** A model judge, when added, is secondary
   and cannot override deterministic failures.
9. **Exposure and visibility are independent experiment variables.** The
   selected values are frozen and reported.
10. **Catalog tools are the scaling default.** Direct tools are intended for
    small, filtered contracts.
11. **The reference implementation is Node.js 24 LTS and strict TypeScript.**
12. **The local product is honest about isolation.** Synthetic homes and
    filtered environments are experimental controls, not a hard boundary. The
    effective isolation level is recorded.
13. **Safe contract mode executes no pack code.** Executable behavior is an
    explicit trusted or isolated scenario mode.
14. **SQLite is the transactional source of truth for mutable run state and
    events.** JSON and JSONL evidence are stable exports.
15. **Steel is migrated before its semantics are corrected.** Any existing
    contract/behavior drift is preserved for historical parity, documented, then
    fixed only in a new pack version.
16. **Ordinary batches remain homogeneous.** Multi-cell randomization belongs to
    a StudyRun parent that interleaves assignments across homogeneous child
    batches.
17. **Study design is explicit and optional.** Pack, Eval, and RunProfile remain
    sufficient for ordinary use; inferential research additionally requires a
    locked StudyProtocol and PhasePlan.
18. **Analytical inputs are immutable before observation.** Protocol materials,
    factor levels, effective contracts, assignment schedule, eligibility,
    replacement, estimands, and analysis code are frozen before the first
    analytical participant starts.
19. **Participant-surface blinding is distinct from process isolation.** Both
    are validated and reported; neither is inferred from the other.
20. **Documentation discovery is an explicit plane.** It is never an automatic
    framework route, product operation, readiness endpoint, or control-plane
    backdoor.
21. **Inferential pooling fails closed.** Descriptive comparison may cross
    compatibility keys with prominent drift output; registered treatment
    estimates may not.
22. **Counterfactual contracts never mutate product truth.** Generated variants
    are research artifacts derived from a pinned base and cannot authorize a
    production API decision.
23. **The safe evaluator remains declarative.** StudyProtocol does not make
    arbitrary JavaScript an acceptable default oracle.

## 9. Fidelity and experiment dimensions

### 9.1 Contract mode

Contract mode provides shape fidelity. It MUST:

- Route every supported path operation explicitly declared in the contract.
- Validate path, query, header, cookie, and body inputs.
- Enforce supported OpenAPI security requirements using dummy credentials.
- Negotiate request and response media types.
- Choose deterministic declared statuses and generate schema-valid responses.
- Record accepted and rejected interactions.
- Return explicit errors for generation limitations.
- Avoid persistent resource semantics unless a declarative fixture explicitly
  supplies them.
- Never execute request content, open a host path derived from it, or fetch a
  URL.

Contract mode MUST NOT infer:

- CRUD persistence.
- Pagination semantics.
- Ownership.
- Idempotency.
- Retry policy.
- Resource lifecycle.
- Cross-operation references.
- Billing or quota behavior.
- Real side effects.

### 9.2 Scenario mode

Scenario mode uses the same routing, parsing, authentication, request
validation, response validation, tracing, and persistence pipeline. A behavior
backend supplies only domain semantics and next state.

A scenario can define:

- Initial state.
- Named fixtures.
- State transitions and guards.
- Stable generated IDs.
- Idempotency behavior.
- Ownership and authorization decisions.
- Virtual time effects.
- Deterministic faults and rate limits.
- Synthetic stand-ins for commands, URLs, browser actions, or other side
  effects.
- Small redacted state projections for evidence.

### 9.3 Exposure treatments

#### Raw HTTP

The participant receives the per-run base URL and declared synthetic
authentication instructions. Contract delivery is controlled independently by
**contract_visibility**: a sanitized file, an explicit documentation facade, or
no complete contract. This treatment can measure contract reading, documentation
discovery, HTTP construction, parameter serialization, and status-driven
recovery without forcing those dimensions to be conflated.

#### Direct tools

One MCP tool is generated for every selected supported operation. This treatment
is allowed only when:

- The selected operation count is at or below 50 by default.
- The serialized total tool schema size is at or below 256 KiB by default.
- The adapter supports isolated per-run MCP configuration.

Thresholds are configurable and recorded. Exceeding them is a preflight error
unless the operator explicitly filters operations or selects catalog tools.

#### Catalog tools

Exactly three tools are exposed:

- **search_operations**
- **describe_operation**
- **invoke_operation**

Search is deterministic and local. It uses tokenized lexical ranking over
operation ID, method, path, summary, description, tags, parameter names, request
property names, and response property names. It MUST NOT require embeddings, a
model, or network access.

Catalog tools MUST not reveal scenario source, initial state, fixtures, hidden
workflows, rubric logic, expected operation order, or grader assertions.

### 9.4 Contract visibility and documentation treatments

- **file:** a sanitized OpenAPI file is copied into the participant workspace.
- **discoverable:** no contract file is copied; an explicitly configured,
  authenticated documentation facade serves the same sanitized localized
  contract bytes from frozen conventional routes. Requests emit
  **documentation.exchange** rather than **api.exchange**.
- **tool-only:** the contract is available only through generated tool
  descriptions.
- **none:** no complete contract artifact is provided; permitted only for an
  explicit benchmark that supplies sufficient task-level documentation.

The default mappings are raw-http/file, direct-tools/tool-only, and
catalog-tools/tool-only. Any other combination is a distinct cell and must pass
adapter preflight. A StudyProtocol MAY assign participant-neutral factor labels
such as supplied, discoverable, and blind to these modes, but factor and level
IDs MUST NOT enter participant-visible artifacts under strict blinding.

The discoverable facade:

- Is disabled unless the effective run profile or StudyProtocol explicitly
  enables it.
- Uses a frozen named route profile; version 1 provides
  **openapi-conventional-v1** with configurable authenticated **GET /** index,
  **GET /openapi.json**, and **GET /.well-known/openapi.json** contract
  candidates.
- Rejects any enabled candidate whose method and normalized path collide with a
  declared product operation. Documentation dispatch never shadows or changes
  ContractIR routing.
- Returns the exact sanitized localized contract bytes used by file visibility
  from each enabled contract candidate, not the original source document. An
  enabled index returns only a deterministic frozen link document naming enabled
  contract candidates and contributes its own participant-surface digest.
- Uses the tested API's declared synthetic authentication unless the profile
  explicitly preregisters another constant policy for every compared cell.
- Is processed before product route matching but remains outside ContractIR
  operation counts and scenario exact-completeness checks.
- Returns the same bounded neutral unknown-route shape as its paired blind
  treatment when disabled, if the StudyProtocol declares those candidate routes
  as controlled discovery probes.
- Exposes no protocol, factor, cell, variant, mock, evaluator, or run label.
- Has a frozen response profile, route inventory, participant-surface digest,
  and separate trace.

No documentation treatment creates a health, reset, state, rubric, grading, or
administration route.

OpenAPI **externalDocs** is sanitized independently from reference resolution.
The policy is **strip** by default, **preserve-reference** only when the
operator explicitly accepts the participant-visible URL text, or
**bundle-declared** when a pack supplies a frozen local document and replaces
the remote URL with a declared participant-local target. No policy authorizes
fetching the URL. The policy, source URL redaction/transformation, bundled asset
inventory, and resulting bytes are participant-surface and cell identity.

### 9.5 Workflow visibility treatments

- **hidden:** workflow assists deterministic grading only.
- **participant:** workflow is frozen and copied to a declared participant path.

Hidden is the default. A workflow’s visibility MUST be frozen as part of cell
identity.

### 9.6 Participant-surface and cue policy

Every trial compiles a private **ParticipantSurfaceManifest** before participant
launch. Study preflight first compiles a pre-localization surface template in
which run ID, random port, credential value, and other permitted run
substitutions are typed placeholders. Cell identity uses that template digest;
each trial additionally records the exact rendered manifest digest. The manifest
is the exhaustive inventory of observable information, including:

- Instructions, task, launch message, filenames, directory layout,
  structured-output schema, and declared workflow files.
- Sanitized contract, documentation bytes, document routes, server descriptions,
  and original-name transformations.
- Environment variable names and every participant-visible non-secret value or
  value-shape rule.
- Credential scheme instructions, generated credential prefix/format, and base
  URL representation.
- HTTP status, headers, bodies, error templates, response-profile catalogs,
  identifier formats, and deterministic timing behavior.
- Tool names, descriptions, schemas, ordering, search corpus/policy, MCP server
  metadata, and adapter-generated messages.
- Sandbox denials and any other framework text capable of reaching participant
  context.

Each entry records source, target or channel, media type, bytes or catalog
digest, maximum size, transformation, and provenance class:

- **contractual:** necessary representation of the selected API contract.
- **task_essential:** explicitly authored task material.
- **treatment:** intentionally varied surface declared by a factor.
- **framework_incidental:** implementation metadata with no study purpose.

Framework-incidental information is removed by default. Compatibility packs MAY
preserve a historical visible cue, but it becomes declared Pack behavior,
receives its own digest, and cannot be treated as neutral.

Prompt sets declare **purpose_disclosure: diagnostic | naturalistic**.
Diagnostic prompts may name the experiment, point at a contract, or request
assumptions. Naturalistic prompts MUST receive no framework-added mention of an
experiment, benchmark, evaluator, rubric, expected operation order,
contract-reading strategy, curl, MCP-discovery strategy, assumptions, or gaps.
Pack-authored domain guidance may be task-essential, but the framework never
invents it.

A strict StudyProtocol additionally declares a cue policy containing:

- Case-insensitive forbidden literals and patterns.
- Explicitly allowed exceptions tied to one surface entry and factor level.
- Treatment-owned paths, routes, fields, and catalogs that may differ.
- Neutral response/credential/server profiles.
- Pairwise expected surface-difference allowlists.
- Required human equivalence/blinding review artifacts.

Preflight scans rendered outputs, not only source templates, and emits a private
cue audit. It then compares every cell pair: differences outside the declared
factor-owned allowlist fail analytical preflight. Lexical scanning is defense in
depth; structural exclusion and reviewer approval remain required. The cue audit
and factor metadata are never participant-visible.

An undeclared participant-visible file, environment name, document route,
response field/header, tool annotation, framework message, or adapter message
makes evidence invalid. Input and surface hashes are verified after execution.
Any participant-surface change creates a new cell even when executable API
semantics are unchanged.

Information blinding and OS isolation are separate fields. A strict cue policy
running under advisory isolation remains easy for a same-user participant
process to bypass and MUST be reported as such.

### 9.7 Experiment cell identity

The following values define a distinct experiment cell:

- Contract semantic digest.
- Contract execution digest and original source-document inventory digest.
- Pre-localization ParticipantSurfaceManifest template digest, including
  sanitized contract transform, documentation facade, response profile,
  credential/base-URL shape, participant files, tools, and dynamic message
  catalogs. Each rendered run digest remains evidence but random
  ports/credentials do not create cells.
- Pack ID and version.
- Scenario ID and digest.
- Eval ID and digest.
- Prompt set and pre-localization rendered prompt-template digest; exact
  per-trial rendered prompt remains evidence but permitted run substitutions do
  not create cells.
- Result schema digest.
- Rubric digest.
- Workflow digest and visibility.
- Adapter ID and version.
- Agent CLI or SDK version.
- Model and effort.
- Exposure mode.
- Contract visibility.
- Documentation-facade profile and discovery-candidate inventory.
- Purpose-disclosure and cue-policy versions.
- Resolved data-plane operation scope.
- Sandbox or isolation profile.
- Timeout and budgets.
- Parallelism.
- ContractVariant ID and base/common/variant/effective digests, when present.
- StudyProtocol, PhasePlan, factor-level, and compatibility digests, when
  present.
- Implementation digest covering compiler, gateway, documentation facade, mock
  adapter and Prism version, generator policy, state store, redactor,
  evaluator/expression engine, statistics, scheduler, response profile, runner,
  adapter, Node runtime, and dependency lock.

Changing any cell value requires a separate child batch. The ordinary compare
command may show cells side by side but MUST warn about every difference and
MUST NOT pool their numerators. A StudyRun declares which differences are
intended factors; its inferential analyzer refuses any undeclared drift or
compatibility-key mismatch.

## 10. System architecture

### 10.1 High-level flow

```text
OpenAPI / Pack / optional StudyProtocol
      |
      v
Ingestion and validation
      |
      +--> frozen source documents
      |
      v
OpenAPI compiler ------> capability report
      |
      v
ContractIR
      |
      +----------+-------------+------------------+
      |          |             |                  |
      v          v             v                  v
HTTP gateway  Tool catalog  Contract backend  Pack validator
      |          |             |                  |
      +----------+------ API execution -----------+
                         |
                         v
               Scenario behavior backend
                         |
                         v
                SQLite state/event store
                         |
                         v
                  normalized evidence
                         |
          +--------------+--------------+
          |                             |
          v                             v
   deterministic evaluator         report builder

Runner --> participant workspace --> agent adapter --> HTTP or MCP
```

### 10.2 Components

#### CLI

Parses operator intent, resolves configuration, presents safety and cost
warnings, invokes application services, prints readiness or outcomes, and maps
errors to stable exit codes. It contains no OpenAPI semantics.

#### Pack loader

Loads and schema-validates pack files, resolves only paths inside the canonical
pack root, freezes referenced assets, calculates digests, and produces the
effective PackIR.

#### Study compiler and scheduler

Validates optional StudyProtocol and PhasePlan objects, resolves factor cells,
verifies contract variants and participant-surface differences, freezes protocol
and runtime locks, and produces a deterministic cross-cell assignment schedule.
It orchestrates homogeneous child batches and contains no API-specific scoring
logic.

#### OpenAPI compiler

Parses JSON or safe YAML, resolves approved references, normalizes OpenAPI
versions, builds ContractIR, and emits diagnostics and capabilities.

#### Gateway

Owns HTTP routing, parsing, deserialization, authentication, request validation,
response serialization, response validation, timeouts, limits, framework errors,
and trace construction.

#### Documentation facade

Optionally serves one frozen sanitized contract through protocol-declared
participant routes. It is a separate participant-support plane, emits
documentation exchanges, cannot reach control state, and is disabled for
ordinary runs unless explicitly selected.

#### Tool facade

Maps direct or catalog MCP calls into the same internal API execution request
used by HTTP. It MUST emit the same normalized API exchange events.

#### Contract backend

Chooses deterministic examples or generates schema-valid responses. It
implements the behavior backend protocol but owns no domain-specific state.

#### Scenario runtime

Hosts a behavior backend in a separate process or hardened runtime, supplies
deterministic clock/IDs/random/blob services, and exposes a narrow message
protocol. It is never loaded into the controller process.

#### State and event store

Uses one per-run SQLite database. It transactionally stores request ordering,
idempotency, domain state, state revisions, response outcome, and normalized
event data. JSON/JSONL artifacts are exports, not the transactional source.

#### Runner

Freezes inputs, builds the participant workspace, creates synthetic home/temp
paths, starts the mock and tool facade, invokes an agent adapter, enforces
timeouts, terminates descendants, archives the workspace safely, evaluates
evidence, and finalizes artifacts.

#### Agent adapter

Probes and invokes a specific agent CLI or SDK using argv-based process creation
and normalized lifecycle events.

#### Evaluator

Compiles a safe rubric, validates structured output, matches trace events and
Arazzo steps, checks final state/artifacts, and returns evidence-bearing check
results.

#### Report builder

Verifies artifact hashes, aggregates immutable evaluations, computes
denominators and confidence intervals, and renders JSON, terminal, Markdown, or
later HTML.

For a StudyRun, it additionally verifies compatibility keys, applies the locked
eligibility and replacement policy, refuses unregistered pooling, and executes
only the preregistered analysis methods.

### 10.3 Package boundaries

Core packages MUST NOT import:

- Any pack under **packs/**.
- Agent-specific code outside the adapter interface.
- CLI presentation code.
- A model SDK.

The Steel pack MAY import only published behavior/test APIs, never private
gateway or runner internals.

The evaluator MUST read only normalized artifacts, never live in-memory gateway
objects.

The adapter MUST not receive paths to hidden state, trace, rubric, behavior, or
fixture files.

### 10.4 Reference repository layout

```text
openapi-agent-lab/
  SPEC.md
  README.md
  package.json
  pnpm-workspace.yaml
  pnpm-lock.yaml
  tsconfig.base.json
  eslint.config.mjs

  apps/
    cli/

  packages/
    core/
    config/
    pack/
    pack-ir/
    openapi/
    contract-ir/
    capability/
    study/
    study-ir/
    scheduler/
    contract-variant/
    gateway/
    documentation-facade/
    mock-adapter/
    mock-contract/
    behavior-api/
    behavior-runtime/
    tools/
    state-store/
    evidence/
    evaluator/
    statistics/
    report/
    runner/
    agent-adapter/
    agent-codex/
    agent-generic/
    testkit/

  schemas/
    pack.v1.schema.json
    pack-ir.v1.schema.json
    prompt-set.v1.schema.json
    eval.v1.schema.json
    eval-case.v1.schema.json
    contract-response-fixture.v1.schema.json
    run-profile.v1.schema.json
    study-protocol.v1.schema.json
    pack-ref.v1.schema.json
    study-ir.v1.schema.json
    phase-plan.v1.schema.json
    protocol-lock.v1.schema.json
    phase-lock.v1.schema.json
    study-run.v1.schema.json
    study-completed.v1.schema.json
    contract-variant-set.v1.schema.json
    contract-variant-manifest.v1.schema.json
    contract-variant-diff.v1.schema.json
    participant-surface-policy.v1.schema.json
    participant-surface-manifest.v1.schema.json
    participant-surface-verification.v1.schema.json
    response-profile.v1.schema.json
    documentation-profile.v1.schema.json
    cue-audit.v1.schema.json
    equivalence-review.v1.schema.json
    blinding-review.v1.schema.json
    source-provenance.v1.schema.json
    assignment-schedule.v1.schema.json
    assignment-event.v1.schema.json
    compatibility.v1.schema.json
    analysis-plan.v1.schema.json
    evidence-requirements.v1.schema.json
    study-analysis.v1.schema.json
    lifecycle-event.v1.schema.json
    contract-ir.v1.schema.json
    capability-report.v1.schema.json
    diagnostic.v1.schema.json
    batch.v1.schema.json
    run-started.v1.schema.json
    run-completed.v1.schema.json
    server.v1.schema.json
    readiness.v1.schema.json
    manual-credentials.v1.schema.json
    trace-event.v1.schema.json
    documentation-event.v1.schema.json
    semantic-event-registry.v1.schema.json
    semantic-event.v1.schema.json
    agent-event.v1.schema.json
    state-summary.v1.schema.json
    rubric.v1.schema.json
    evaluation.v1.schema.json
    cohort-evaluation.v1.schema.json
    report.v1.schema.json
    friction.v1.schema.json
    resource-usage.v1.schema.json
    artifact-manifest.v1.schema.json
    conformance.v1.schema.json

  packs/
    steel-computer/
      pack.yaml
      contract/
        openapi.json
      behavior/
        index.ts
      fixtures/
      prompts/
      tasks/
      schemas/
      evals/
      workflows/
      tests/

  studies/
    steel-agent-native-checkpoint-v1/
      study.yaml
      protocol.lock.json
      phases/
      variants/
      reviews/

  tests/
    fixtures/
      openapi/
      adversarial/
    golden/
    integration/
    security/
    e2e/

  docs/
    authoring-packs.md
    adapter-api.md
    security.md
    capability-matrix.md
    authoring-studies.md
    research-methods.md
```

### 10.5 Technology choices

- Node.js 24 LTS.
- TypeScript with strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes,
  and ESM.
- pnpm workspaces with a committed lockfile.
- JSON Schema Draft 2020-12 for project artifacts.
- A validator with OpenAPI 3.0 compatibility support and format validation
  isolated behind an interface.
- SQLite with WAL for transactional run state.
- Safe YAML parsing with duplicate-key and alias controls.
- A pinned CEL implementation or equivalently restricted expression evaluator
  for rubrics.
- Native Node HTTP is acceptable; framework choice MUST not add automatic
  routes.
- Vitest for unit, integration, golden, and black-box test orchestration.
- Release artifacts include an SBOM and provenance.

All dependencies that interpret schemas, YAML, templates, expressions, or
untrusted content require an explicit security review and version pin.

## 11. Common persisted-artifact conventions

All persisted JSON artifacts MUST:

- Use UTF-8 and end with exactly one newline.
- Contain an integer **schema_version**.
- Contain only JSON values; undefined, NaN, Infinity, functions, and platform
  objects are forbidden.
- Use RFC 3339 UTC timestamps, for example 2026-08-27T12:34:56.789Z.
- Use lowercase 64-character SHA-256 digests.
- Put non-standard metadata under an **extensions** object whose keys are
  reverse-DNS or pack-prefixed.
- Never persist a resolved credential value or an unkeyed hash of one.

IDs used in paths MUST match:

```text
^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$
```

Readers MUST reject unsupported schema versions. Writers MUST increment a schema
version for incompatible changes. Batch and trial directories MUST use
exclusive-create semantics and MUST never be reused or overwritten.

Canonical JSON used for semantic digests MUST follow one documented
canonicalization algorithm: recursively lexicographically sorted object keys,
unchanged array order where order is semantic, normalized number representation,
UTF-8, and no insignificant whitespace. Source digests always cover original
bytes.

ContractIR also carries **execution_sha256**, calculated over canonical
runtime-relevant IR after non-semantic collections are normalized. Every
ordering choice that can change routing, authentication, validation, response
selection, tool search, or generation contributes to this digest. Human-only
diagnostic wording is excluded. A separate **contract_surface_sha256** covers
the sanitized bundled contract or generated tool catalog; the full
pre-localization ParticipantSurfaceManifest template digest combines it with
every other participant channel.

**implementation_sha256** is a canonical manifest digest over exact component
versions/bundle hashes, generator/search policy versions,
Prism/validator/expression-engine versions, documentation facade and response
profile, scheduler/statistics implementations, Node runtime, platform-relevant
sandbox implementation, and dependency lock digest. These digests are part of
cell identity even when semantic contract content is unchanged.

## 12. Configuration model

### 12.1 Separation of concerns

The product uses four different configuration concepts:

1. **Pack:** which contract, behavior, scenario, participant materials, Eval,
   and deterministic rubric are available.
2. **Run profile:** how one homogeneous experiment cell is executed.
3. **StudyProtocol:** optional preregistered relationship among multiple cells,
   phases, assignments, estimands, and analyses.
4. **CLI invocation:** permitted runtime constants, maintainer actions, and
   output preferences.

A pack MUST NOT hard-code a provider credential, host path, or model. A run
profile MUST NOT contain hidden business assertions. A StudyProtocol MUST NOT
reimplement behavior, semantic registries, or scoring; it references immutable
Pack/Eval and declarative variant inputs. A ContractVariantSet may select
Pack-owned behavior adapters and semantic schemas by pinned ID/digest, but it
cannot embed executable behavior or replace the Eval. A study that needs
behavior unavailable from its current Pack MUST use a separate immutable
research PackRef. CLI overrides MUST be frozen into effective batch or phase
metadata and MUST NOT override locked analytical design choices.

Ordinary run precedence, from lowest to highest:

1. Built-in defaults.
2. Pack defaults.
3. Named run-profile file.
4. CLI flags.

For an analytical StudyRun, precedence is:

1. Built-in defaults.
2. Pack defaults.
3. Protocol base RunProfile.
4. Typed factor-level bindings.
5. Fixed PhasePlan values.
6. CLI values only for fields the PhasePlan declares as required runtime
   bindings.

A study CLI disagreement with a factor binding or fixed design value is an
error, not an override. Every effective value and its provenance MUST appear in
**batch.json** or, for a StudyRun, **phase.lock.json** and the relevant child
**batch.json**. Environment variables may supply secret values and a small
documented set of permitted runtime bindings, but their names—not values—are
recorded.

### 12.2 Pack manifest example

```yaml
apiVersion: agentlab.dev/v1
kind: Pack

metadata:
  id: steel-computer
  name: Steel Computer
  version: 1.0.0
  description: Stateful Steel Computer contract-comprehension eval

requires:
  agentlab: ">=0.1.0 <0.2.0"
  backend_api: 1
  rubric_api: 1

contract:
  entrypoint: contract/openapi.json
  compile:
    remote_refs: deny
    unsupported_features: error
    warnings_as_errors: false
  participant_copy:
    filename: openapi.json
    bundle_refs: true
    replace_servers: true
    external_docs: strip
  response_fixtures: []

server:
  host: 127.0.0.1
  port: 0
  request_body_limit_bytes: 5242880
  request_timeout_ms: 30000
  response_validation: error
  request_validation: error
  concurrency: serial

behavior:
  mode: scenario
  backend:
    kind: module
    entrypoint: behavior/index.ts
    export: backend
  completeness: exact
  fallback: none
  state_schema_version: 1
  state_schema: schemas/steel-state.schema.json
  clock:
    kind: virtual
    initial: "2000-01-01T00:00:00.000Z"
    tick_ms: 1
  random:
    seed: run
  fixtures:
    - fixtures/system-templates.json

security:
  enforce: true
  credentials:
    - id: primary-api-key
      scheme: steelApiKey
      provider:
        kind: generated
        bytes: 32
      expose:
        environment: STEEL_API_KEY
  base_url_environment: STEEL_BASE_URL

idempotency:
  policies:
    - id: create-computer
      operations:
        - "path:POST /v1/computers"
      key:
        location: header
        name: Idempotency-Key
      principal_scope: authenticated_principal
      cache_statuses: ["201"]
      cache_failures: false
      ttl:
        kind: none
      max_entries: 10000
      conflict_status: 409

redaction:
  header_names:
    - authorization
    - steel-api-key
    - x-api-key
  key_patterns:
    - "(?i)api.?key"
    - "(?i)token"
    - "(?i)secret"
    - "(?i)password"
    - "(?i)credentials"
    - "(?i)private.?key"
  capture_binary_blobs: false
  max_text_capture_bytes: 65536

participant:
  environment:
    inherit: none
    allow:
      - PATH
      - HOME
      - TMPDIR
      - STEEL_BASE_URL
      - STEEL_API_KEY

prompt_sets:
  - id: diagnostic
    purpose_disclosure: diagnostic
    instructions:
      source: prompts/diagnostic/instructions.md
      engine: mustache-strict
      delivery: file
      target: AGENTS.md
    launch:
      source: prompts/diagnostic/launch.txt
      engine: literal

evals:
  - id: checkpoint-recovery
    prompt_set: diagnostic
    task:
      source: tasks/checkpoint-recovery/task.md
      engine: mustache-strict
      target: TASK.md
    participant_files:
      - source: schemas/checkpoint-recovery-result.schema.json
        target: result.schema.json
    operation_scope:
      mode: all
    result:
      source: adapter_final
      schema: schemas/checkpoint-recovery-result.schema.json
      required: true
    rubric: evals/checkpoint-recovery/rubric.yaml
    scenario: baseline

scenarios:
  - id: baseline
    fixtures:
      - fixtures/baseline.json

extensions: {}
```

### 12.3 Pack invariants

- Pack references are POSIX paths relative to the canonical pack root.
- Absolute paths, parent traversal, NUL bytes, symlink escape, and real paths
  outside the root are forbidden.
- Referenced assets MUST exist and be regular files at validation time.
- Unknown manifest keys are errors, except under **extensions**.
- Validation and compilation MUST finish before an agent process starts.
- **behavior.mode** is contract or scenario.
- **completeness: exact** means every path operation is declared exactly once by
  the scenario backend and no unknown operation is declared.
- **fallback: contract** is allowed only when the pack explicitly chooses
  partial scenario fidelity.
- A scenario using exact completeness MUST set fallback to none.
- Every task declares **operation_scope** as all, an explicit list of canonical
  keys, or a deterministic selector over tags/methods. Validation resolves it to
  a frozen canonical-key list. Strict preflight applies task-required capability
  checks to that list.
- Operations outside task scope remain part of ContractIR. Whether they are
  exposed is a separate recorded **data_plane_scope** treatment; they are never
  silently removed.
- Participant server rewriting changes only the copied contract; original bytes
  and ContractIR remain unchanged.
- Secret values never appear in a pack.
- Prompt-set IDs and eval IDs are unique safe IDs. Every eval resolves exactly
  one prompt set, one task source, one scenario, one result contract, and one
  rubric.
- Each prompt_sets item validates against **prompt-set.v1.schema.json** and each
  evals item against **eval.v1.schema.json** before cross-reference resolution.
  They are named nested objects in pack version 1, not ad hoc directory
  conventions.
- Template engines in version 1 are literal and mustache-strict.
- Strict templates allow substitution only: no expressions, filesystem,
  environment, commands, includes, helpers, or network.
- Missing variables are fatal before the run.
- Hidden rubrics, behavior, fixtures, state, traces, and hidden workflows are
  not copied to the participant.
- Executable behavior is trusted code. Third-party packs require an explicit
  warning and may require an isolated runtime profile.
- TypeScript behavior entrypoints are bundled during strict preflight into one
  content-addressed ESM artifact. The frozen bundle, source inventory,
  source-map policy, bundler name, and bundler version are recorded. The runtime
  executes the bundle, never transpiles participant-controlled code on demand.

### 12.4 Run profile example

```yaml
apiVersion: agentlab.dev/v1
kind: RunProfile

metadata:
  id: codex-high-raw-sequential

agent:
  adapter: codex-cli
  model: MODEL_ID
  effort: high
  sandbox: workspace-write

exposure:
  mode: raw-http
  contract_visibility: file
  data_plane_scope: all

execution:
  count: 10
  parallel: 1
  timeout_ms: 1800000
  cohort_seed: steel-baseline-2026-08-27
  confirm_paid_calls: true

evaluation:
  model_judge: disabled
  fail_on:
    required_check: true
    infrastructure: true

limits:
  max_agent_tool_calls: 500
  max_api_requests: 10000
  max_artifact_bytes: 1073741824
```

Run profiles and batches MUST be homogeneous. Matrix expansion outside StudyRun
is a CLI convenience that creates separate immutable batches, one per cell. A
StudyRun may preregister and interleave assignments across those child batches,
but every child batch still resolves exactly one cell and every trial records
exactly one immutable assignment.

### 12.5 Effective PackIR

Strict pack validation produces immutable PackIR. It contains:

- Fully resolved manifest defaults.
- Canonical in-root absolute paths for internal execution and safe relative
  paths for artifacts.
- ContractIR and capability digest.
- Scenario and fixture inventory.
- Bundled behavior source inventory and digest.
- Compiled prompt/template plan.
- Participant file plan with source/target/digest/visibility.
- Credential declarations without values.
- Compiled task, workflow, result-schema, and rubric references.
- Effective limits and trust requirement.
- All warnings and extension data.

PackIR contains no unresolved template, symlink, unknown key, environment
secret, or executable source text. **pack-ir.v1.schema.json** validates its
serialized form. The runner consumes PackIR rather than rereading pack files
after preflight.

Resolved task data records both:

- **operation_scope:** operations whose fidelity is required for the eval.
- **data_plane_scope:** all operations or the eval scope exposed to the
  participant.

The default is all for both. Filtering the data plane changes experiment-cell
identity and causes the participant contract/tool catalog to be derived and
separately hashed.

### 12.6 Evaluation cases

A task MAY declare a bounded JSONL case source and a Draft 2020-12 input schema:

```yaml
cases:
  source: tasks/checkpoint-recovery/cases.jsonl
  schema: schemas/checkpoint-recovery-case.schema.json
  id_pointer: /id
```

Each non-empty line is one JSON object with a unique safe case ID. Cases:

- Contain synthetic non-secret task inputs only.
- Validate before batch creation.
- Are frozen and hashed.
- Expose only explicitly referenced **case.input** values through templates.
- Do not alter hidden rubric or scenario code dynamically.

**--count N** schedules N repetitions per selected case. A batch may contain
multiple planned cases under one treatment, but reports MUST stratify by case
and provide a macro aggregate that gives each case equal weight. Case ID and
input digest are run identity, not an unreported treatment difference.

### 12.7 StudyProtocol responsibility

StudyProtocol is an optional research layer. It does not replace Pack, Eval,
RunProfile, or rubric:

- **Pack** defines the executable API world.
- **Eval** defines one task, participant result contract, and deterministic
  scoring.
- **RunProfile** defines one homogeneous execution cell.
- **StudyProtocol** declares why and how multiple cells may be compared.
- **PhasePlan** freezes one smoke, pilot, confirmatory, or other named phase.
- **StudyRun** executes the frozen cross-cell schedule and owns inferential
  analysis lineage.

Bare contract serving, single trials, and ordinary homogeneous cohorts MUST work
without a StudyProtocol. Any command that reports a registered treatment effect,
p-value, multiplicity-adjusted result, winner, or confirmatory conclusion MUST
require one.

### 12.8 StudyProtocol example

```yaml
apiVersion: agentlab.dev/v1
kind: StudyProtocol

metadata:
  id: prepared-workspace-api-v1
  version: 1.0.0
  title: Prepared workspace API-shape study

objective: >-
  Compare equally capable API surfaces for completing one prepared-workspace
  task while controlling documentation availability.

evaluation:
  pack:
    id: workspace-service
    version: 1.0.0
    sha256: DIGEST
  eval: prepare-and-replicate
  scenario: baseline
  contract_variant_set: variants/api-shapes.yaml

factors:
  - id: api_shape
    role: treatment
    levels:
      - id: shape_a
        contract_variant: shape-a
      - id: shape_b
        contract_variant: shape-b

  - id: documentation
    role: treatment
    levels:
      - id: supplied
        run_profile_patch:
          exposure.contract_visibility: file
      - id: discoverable
        run_profile_patch:
          exposure.contract_visibility: discoverable
          exposure.documentation_profile: openapi-conventional-v1
      - id: blind
        run_profile_patch:
          exposure.contract_visibility: none

constants:
  run_profile: profiles/codex-high-raw-sequential.yaml
  required_parallel: 1
  data_plane_scope: all
  response_profile: neutral-v1

metrics:
  primary:
    - id: clean_completion
      type: binary
      source:
        kind: rubric_check
        check_id: clean_completion
  secondary:
    - id: request_count
      type: integer
      source:
        kind: trace_aggregate
        aggregate: participant_api_request_count
    - id: documentation_requested
      type: binary
      source:
        kind: documentation_aggregate
        aggregate: participant_requested_any
    - id: false_complete
      type: binary
      source:
        kind: rubric_signal
        signal_id: false_complete

blinding:
  mode: strict
  participant_surface_policy: blinding/participant-surface.yaml
  require_pairwise_surface_diff_review: true

phases:
  smoke: phases/smoke.yaml
  pilot: phases/pilot.yaml

interpretation_limits:
  - The study measures the declared end-to-end task, not spontaneous use in
    unrelated work.
  - A contract diff allowlist does not by itself prove semantic equivalence.
  - Pilot estimates are directional unless a separate confirmatory phase is
    frozen.

extensions: {}
```

Factor IDs, level IDs, assignment labels, protocol IDs, and phase IDs are
control-plane metadata. They are unavailable to participant templates under
strict blinding. A run-profile patch is a schema-checked mapping over an
explicit allowlist of treatment fields; dotted keys in the example are
serialized into a canonical nested object in StudyIR.

The **evaluation.pack** object validates against **pack-ref.v1.schema.json** and
contains exactly a safe Pack ID, semantic version, and lowercase SHA-256.
Location is deliberately absent; command resolution supplies local bytes and
proves their compiled Pack digest matches.

Version 1 factor roles are **treatment**, **exposure**, **blocking**, and
**nuisance**. By default the cell inventory is the complete Cartesian product in
canonical factor/level order; a protocol may instead list an explicit subset and
must state why each combination is absent. A PhasePlan cannot silently drop a
resolved cell.

Canonical expansion sorts factors by factor ID and levels by level ID using
Unicode code-point order, then enumerates the Cartesian product
lexicographically by the resulting ordered level map. The default cell ID joins
those level IDs with **\_\_**; if that would collide, exceed the safe-ID limit,
or be ambiguous because a level contains **\_\_**, validation requires explicit
unique cell IDs. An explicit subset lists each complete factor-to-level map
exactly once. Unknown/missing factors, duplicate maps, unused listed cells, and
a claimed complete factorial whose derived count differs from the product of
level counts are errors.

Typed factor bindings may select a ContractVariant, scenario, prompt set,
exposure mode, contract visibility, documentation profile, workflow visibility,
data-plane scope, adapter/model/effort, sandbox profile, timeout/budget,
parallelism, or an explicitly schema-registered Pack extension. They cannot
patch arbitrary JSON. Two factors binding the same effective field are invalid
unless the protocol declares one schema-validated interaction binding. Every
varied field becomes cell identity; undeclared variation is drift.

### 12.9 PhasePlan example

```yaml
apiVersion: agentlab.dev/v1
kind: PhasePlan

metadata:
  id: pilot

purpose: exploratory
analytical: true

design:
  kind: complete-balanced-blocks
  primary_assignments: 12
  explicit_seed_required: true
  block:
    cells: all
    repetitions: 2
  ordering: canonical-sha256-sort-v1

replacements:
  kind: held-same-cell
  slots_per_cell: 1
  activation_timing: after_primary_schedule
  activate_on:
    - disposition: infrastructure_failed_pre_control
    - disposition: provider_failed_pre_control
    - disposition: infrastructure_failed_post_control
      evidence_integrity: [corrupt, missing]
    - disposition: provider_failed_post_control
      evidence_integrity: [corrupt, missing]
  maximum_activated_per_cell: 1

runtime_lock:
  required_fields:
    - agent.adapter
    - agent.version
    - agent.model
    - agent.effort
    - sandbox.profile
    - execution.timeout_ms
    - execution.parallel
    - implementation_sha256

eligibility:
  primary_agent_outcome:
    require: participant_control_started
    exclude:
      - censor_class: administrative_censor
      - censor_class: instrumentation_censor
  api_behavior:
    require:
      - participant_control_started
      - trace_intact

stopping:
  batch_wide_pre_control_failure: abort
  second_unreplaced_failure_in_cell: incomplete
  operator_interruption: abort
  data_dependent_success_stop: forbidden

analysis:
  contrasts:
    - id: shape_a_minus_shape_b_within_discoverable
      metric: clean_completion
      factor: api_shape
      levels: [shape_a, shape_b]
      direction: first_minus_second
      within:
        documentation: discoverable
  primary_estimand:
    id: clean_completion_risk_difference
    outcome: clean_completion
    population: primary_agent_outcome
    contrast: shape_a_minus_shape_b_within_discoverable
    measure: risk_difference
  comparison_families:
    - id: primary
      contrasts:
        - shape_a_minus_shape_b_within_discoverable
      alpha: 0.05
      multiplicity: holm
  methods:
    binary_interval: wilson
    risk_difference_interval: newcombe
    exact_test: fisher_two_sided
  sensitivity:
    participant_control_started_censors_as_failure: true
  marginal_weighting: none
  floor_ceiling:
    apply_by_factor_level: documentation
  small_sample_label: directional

paid_calls:
  primary: 12
  maximum_with_replacements: 18
```

The numbers above are illustrative, not product defaults. A phase with
**analytical: false** is operational evidence only and is excluded from
treatment estimates. A confirmatory phase additionally MUST declare directional
hypotheses, familywise error policy, smallest effect worth acting on,
sample-size or power rationale, and a separately approved analysis lock. Pilot
results cannot silently become a confirmatory plan.

Metric definitions use a closed typed source union: **rubric_check**,
**rubric_signal**, **trace_aggregate**, **documentation_aggregate**,
**semantic_aggregate**, **state_projection**, **participant_report**, or a named
bounded derived expression compiled by the rubric DSL. Each declares an output
type and missingness policy. Contrast objects explicitly name one metric,
factor, ordered levels/direction, optional within-factor strata, population, and
measure. Validation resolves every
metric/check/signal/aggregate/factor/level/stratum reference, verifies type
compatibility, and rejects an orphan, free-form source string, empty stratum, or
contrast over a nonvarying factor.

Eval and PhasePlan compilation also produces a frozen **evidence_requirements**
manifest mapping each metric/estimand to required normalized streams, state
projections, lifecycle/surface verification, and conditional report/artifact
facts. A primary metric dependency is required by default. Optional secondary
inputs declare **unknown**, **not_applicable**, or another typed missingness
result; omission cannot silently become zero or global task failure.

### 12.10 Protocol and phase locks

Strict validation writes no lock implicitly. A maintainer explicitly creates or
refreshes a lock; normal preflight checks it and fails on drift.

**protocol.lock.json** contains:

```json
{
  "schema_version": 1,
  "protocol_id": "prepared-workspace-api-v1",
  "protocol_version": "1.0.0",
  "protocol_source_sha256": "PROTOCOL_DIGEST",
  "members": {
    "study.yaml": "DIGEST",
    "phases/pilot.yaml": "DIGEST",
    "profiles/codex-high-raw-sequential.yaml": "DIGEST",
    "variants/api-shapes.yaml": "DIGEST",
    "blinding/participant-surface.yaml": "DIGEST"
  },
  "effective_contracts": {
    "shape-a": "DIGEST",
    "shape-b": "DIGEST"
  },
  "pack": {
    "id": "workspace-service",
    "version": "1.0.0",
    "sha256": "DIGEST"
  }
}
```

The protocol lock digest is SHA-256 over the canonical JSON bytes of this lock.
The lock never contains its own digest. Every study-owned member path is a safe
protocol-root path. Absolute paths, parent traversal, duplicate normalized
paths, symlink escape, missing files, and unlocked remote content fail
validation. The PackRef contains identity/version/digest only and is resolved
separately under the Pack's canonical root from an operator-supplied local pack
or an installed content-addressed local catalog; it never supplies a filesystem
path or triggers network retrieval.

Before the first assignment starts, the runner creates **phase.lock.json**
containing:

- Protocol-lock and selected PhasePlan digests.
- Frozen runtime values required by the phase.
- Agent adapter/CLI feature-probe and help digests.
- Model, effort, and inference settings observable to the adapter.
- Node, OS, architecture, sandbox, timeout, limits, and parallel policy.
- Compiler, gateway, backend, state, redaction, evidence, runner, evaluator,
  statistics, scheduler, documentation-facade, response-profile, and
  dependency-lock digests.
- Assignment schedule and schedule-code digests.
- Ordered cell inventory with effective contract, participant-surface, behavior,
  Eval, rubric, and RunProfile digests.
- Complete assignment-to-run binding map containing deterministic run IDs/seeds
  and child-batch IDs after all runtime-dependent surface/profile values
  resolve.
- Evidence-requirements, metric missingness, censoring, and worst-case policy
  digests.
- Git/release provenance sufficient to identify exact behavior-affecting source
  or build artifacts.

The phase lock likewise omits its own digest. **phase_lock_sha256** is
calculated from its canonical JSON bytes and recorded by the StudyRun, every
child batch, assignment evidence, and analysis.

Analytical phases MUST run from a content-addressed release or a clean
behavior-affecting worktree. Development and non-analytical smoke MAY permit an
explicit dirty override, but it records status, diff digest, exact relevant
source/build inventory, and automatic exclusion from treatment estimates.

Once the first paid analytical assignment durably reaches
**participant_spawned**, source protocol and phase-plan inputs are permanently
immutable for that protocol version. Any prompt sentence, task, result schema,
participant filename, contract transform, behavior, response profile, cue
codebook, rubric, metric, eligibility rule, scheduler, replacement rule, or
analysis change requires a new protocol version and lock. Reanalysis of
unchanged evidence creates a derived analysis artifact, never an edited
protocol.

### 12.11 Deterministic StudyRun scheduling

A StudyRun owns one immutable **assignments.json** generated before a server or
participant starts. Each assignment records:

- assignment_id, kind **primary** or **held_replacement**, and immutable initial
  status **planned** or **held**. Activation is recorded in an append-only
  assignment event and never rewrites this file.
- study_run_id, phase_id, cell_id, child_batch_id, and stable slot.
- For a primary: block_id and repetition_index. For a held replacement:
  reserve_index and the eligible cell/stratum policy, but no invented failed
  target.
- Ordered factor levels and their digests.
- Protocol-time ContractVariant, participant-surface-policy, Eval, scenario,
  rubric, and base RunProfile-template digests; runtime-dependent effective
  profiles belong to the later phase lock.
- Deterministic schedule sort key. Assignment schedules intentionally contain no
  model/adapter-dependent run seed or effective cell-compatibility digest.
- Prospective assignment kind/status only; actual replacement target, reason,
  inherited analytical stratum, activation timestamp, and launch order belong
  exclusively to **assignment-events.jsonl**.

For **complete-balanced-blocks**, the primary count MUST be divisible by the
resolved cell count. Every block contains every cell exactly once unless the
PhasePlan explicitly declares another balanced block structure. The scheduler
orders assignments within each block by the lexicographic SHA-256 of canonical
JSON containing:

```json
{
  "schema_version": 1,
  "algorithm": "canonical-sha256-sort-v1",
  "protocol_lock_sha256": "DIGEST",
  "phase_plan_sha256": "DIGEST",
  "schedule_seed": "pilot-fixed-seed",
  "block_id": 0,
  "cell_id": "shape_a__discoverable",
  "assignment_kind": "primary"
}
```

A held replacement sort key uses the same object without **block_id** and adds
**assignment_kind: held_replacement** plus zero-based **reserve_index**. Primary
blocks remain first. Held entries are stored in canonical cell/reserve sort
order and enter executable launch order only through their frozen
activation-timing rule.

Assignment, child-batch, and later run IDs are generated from domain-separated
canonical objects, not truncated concatenations of author IDs: **asg\_**,
**bat\_**, or **run\_** plus the first 24 lowercase hexadecimal characters of
SHA-256 over StudyRun ID, phase, cell, assignment kind, and block/repetition or
reserve index as applicable. The generator checks the full digest behind every
shortened ID and extends all colliding IDs deterministically to 32 characters.
These control IDs never enter participant material.

The scheduler never uses delimiter-concatenated variable-length strings.
Assignment order is independent of PRNG library, parallel worker count, provider
latency, completion order, failure, or replacement activation. Blocks remain in
numeric block order so temporal drift cannot cluster a whole cell by
construction.

During StudyRun preflight, after runtime values and exact cell surface templates
resolve, the frozen schedule seed is the **cohort_seed** input to section 17.5
run-seed derivation. A primary uses assignment kind **primary** and its
within-cell repetition index; a held slot uses kind **held_replacement** and its
reserve index. The domain separation guarantees primary index 0 and reserve
index 0 have different seeds. The resulting assignment-to-run ID/seed bindings
are written inside the non-self-referential phase lock; they never rewrite
**assignments.json**. Effective contract, surface-template, scenario, behavior,
Eval, and case digests keep treatment-specific run seeds explicit without using
condition labels as entropy.

Held replacements are frozen capacity, not trials. They become activated only
when the locked replacement policy selects them. An unused slot is
**held_unused**, consumes no call, has no run directory, and enters no trial
denominator. Replacement activation is outcome-blind, cell-matched,
capacity-bounded, and append-only. A batch-wide launcher/configuration defect
aborts the StudyRun without consuming held slots.

Version 1 replacement timing is either **immediate_after_terminal** or
**after_primary_schedule** and is frozen by the PhasePlan. A held slot is not
assigned permanently to one primary block. On activation, an append-only event
maps it to exactly one eligible failed assignment and inherits that assignment's
registered block/stratum for analysis while retaining its actual later launch
position. One held slot cannot satisfy two primaries. A required block is
analytically complete only when each primary analysis slot has either its own
eligible outcome or one valid mapped replacement; otherwise the analyzer reports
the block incomplete and applies the PhasePlan's refusal rule. Main and
worst-case outcomes both remain one value per slot under section 27.2;
replacement never creates an extra blocked observation.

### 12.12 Counterfactual ContractVariant sets

A StudyProtocol MAY reference a versioned ContractVariantSet. Version 1
supports:

- Committed static effective contracts pinned by digest.
- A common declarative RFC 6902 JSON Patch projection followed by one
  declarative variant patch.
- An explicitly trusted/isolated generator extension in a later capability
  profile; executable transformation is never part of contract-safe mode.

Each set declares:

- Immutable base source bytes and source digest.
- One optional common projection and its exact JSON-Pointer allowlist.
- Variant ID, transform or static source, exact allowlist, expected operation
  inventory, and effective digest.
- Canonical operation-to-Pack-owned-behavior-adapter coverage, including
  immutable adapter IDs and digests.
- References and digests for Pack-owned participant-neutral documentation fact
  IDs, required placement classes, and examples that must exist across variants.
- References and digests for Pack-owned variant-neutral semantic action IDs,
  input/output schemas, and semantic-event schemas.
- Expected constant and intentionally variable participant surfaces.

Generation parses fresh base bytes for every materialization, applies common
projection before the variant transformation, serializes deterministically,
recompiles the effective document through the ordinary compiler, and verifies:

1. Base bytes remain unchanged.
2. Every structural difference is allowlisted at the correct layer.
3. Every source/effective operation has the declared capability and selected
   behavior adapter.
4. Unrelated paths, components, response shapes, authentication, validation
   strictness, idempotency, error informativeness, and business capability
   remain byte- or semantic-digest identical as declared.
5. Documentation facts and placement classes are parallel across variants.
6. No protocol, phase, factor, level, assignment, experiment, mock, or internal
   maturity label leaks into participant contract bytes.
7. Every effective contract passes OAL compilation and the configured external
   lint gate with zero unwaived diagnostics.

A diff allowlist, fact table, shared bundle, or passing test is evidence for
review, not proof of scientific equivalence. Analytical launch requires an
explicit equivalence review artifact naming reviewers, reviewed digests,
findings, and approval. A variant that needs different domain semantics, success
probability, validation leniency, error actionability, or hidden state is an
invalid comparison rather than a new branch in the shared kernel.

ContractVariantSet content is declarative control-plane data. Adapter mappings
are selectors over the referenced Pack's immutable registry; semantic schema
entries are references to that Pack's immutable registry. A set MUST NOT contain
JavaScript, WASM, commands, inline handler source, dynamic module paths, or
evaluator code. If any effective operation cannot resolve exactly one compatible
Pack-owned adapter and semantic schema under the frozen PackRef, preflight
fails. Adding an adapter or semantic fact therefore requires a new Pack
version/digest, never a study-directory executable overlay.

### 12.13 Study invariants

- Protocol, phase, factor, level, cell, metric, estimand, contrast, and
  assignment IDs are unique safe IDs.
- Factor expansion is deterministic and produces a lexicographically ordered
  cell inventory before scheduling.
- Every intended treatment difference is declared by exactly one factor level or
  an explicit interaction; all other effective differences are drift.
- A PhasePlan cannot be loosened by CLI flags. A disagreement fails before
  permanent artifacts or paid calls.
- Smoke/development evidence never enters analytical denominators.
- The same Pack, Eval, primary metric definition, and participant result
  contract apply across compared cells. Version 1 factors cannot select or patch
  them; comparing different tasks or primary oracles requires separate StudyRuns
  and an explicitly declared higher-level synthesis.
- Participant-surface policy validates rendered bytes, names, routes, response
  profiles, and environment names, not only source templates.
- Study analysis reads frozen artifacts only and never queries live provider
  state or hidden chain-of-thought.
- StudyProtocol does not authorize arbitrary evaluator code. The default oracle
  remains the rubric DSL; a custom scorer requires a separately named trusted or
  isolated evaluator profile and becomes part of compatibility identity.
- A favorable counterfactual result is evidence for a later human product
  decision. It never edits the source product contract, changes Pack behavior,
  or marks an API shape adopted.

### 12.14 StudyRun persisted contract

**study-run.v1.schema.json** is the immutable execution header for one
PhasePlan:

```json
{
  "schema_version": 1,
  "study_run_id": "api-shape-pilot-01",
  "created_at": "2026-08-27T12:00:00.000Z",
  "protocol": {
    "id": "prepared-workspace-api-v1",
    "version": "1.0.0",
    "protocol_lock_sha256": "DIGEST"
  },
  "phase": {
    "id": "pilot",
    "kind": "pilot",
    "analytical": true,
    "phase_plan_sha256": "DIGEST",
    "phase_lock_sha256": "DIGEST"
  },
  "assignment_schedule": {
    "algorithm": "canonical-sha256-sort-v1",
    "sha256": "DIGEST",
    "primary_count": 12,
    "held_replacement_count": 6,
    "maximum_agent_launches": 18
  },
  "study_compatibility_sha256": "DIGEST",
  "implementation_sha256": "DIGEST",
  "analysis_plan_sha256": "DIGEST",
  "child_batches": [
    {
      "cell_id": "shape_a__discoverable",
      "batch_id": "bat_4f12ab34cd56ef7890ab1234",
      "relative_path": "batches/bat_4f12ab34cd56ef7890ab1234",
      "factor_levels": {
        "api_shape": "shape_a",
        "documentation": "discoverable"
      },
      "cell_compatibility_sha256": "DIGEST"
    }
  ],
  "extensions": {}
}
```

The real object lists every resolved cell in canonical cell-ID order. It is
written exclusively after all no-paid preflight succeeds and before the first
listener or participant starts. It contains no mutable progress or terminal
status; **assignment-events.jsonl**, child lifecycle ledgers, and
**study.completed.json** record later facts.

Every frozen primary and held assignment maps to exactly one listed child batch.
Batch IDs and safe relative paths are derived deterministically with collision
checks. Each child batch records the StudyRun, protocol lock, phase lock,
schedule, cell, and compatibility digests, but participant templates cannot
access those identifiers. A global scheduler may dispatch non-contiguous
assignments to a child batch; completion order cannot change assignment order or
cell membership. An aborted analytical StudyRun is never resumed in place.

## 13. OpenAPI ingestion and compilation

### 13.1 Accepted input

Version 0.1 accepts:

- OpenAPI 3.0.x and 3.1.x.
- JSON, YAML, and YML files.
- Same-pack relative file references.
- UTF-8 text.

For a bare source file, the canonical parent directory of the entrypoint is its
implicit reference root. Only transitively referenced regular files inside that
root are read. A symlink or resolved path outside the root is rejected. A pack
uses its canonical pack directory as the reference root.

The compiler rejects:

- Swagger/OpenAPI 2.0 with **OAL-OAS-VERSION-UNSUPPORTED**.
- OpenAPI 3.2 with a capability message that recommends a future compiler
  version.
- Remote HTTP, HTTPS, file, data, and custom-scheme references by default.
- Paths escaping the pack root.
- Duplicate JSON or YAML mapping keys.
- Unbounded YAML aliases or document depth.

### 13.2 Compilation stages

1. Read bounded source bytes and calculate source SHA-256.
2. Detect JSON or YAML from content, not filename alone.
3. Parse using safe limits and duplicate-key detection.
4. Validate the OpenAPI structural document.
5. Discover and freeze permitted reference documents.
6. Resolve references into a graph without infinitely inlining cycles.
7. Normalize OpenAPI 3.0 schema semantics to validation-equivalent JSON Schema.
8. Merge inherited servers, parameters, security, and tags.
9. Compile operations, serializers, request bodies, responses, and security
   alternatives.
10. Detect ambiguous routes and tool-name collisions.
11. Calculate operation support and document capability outcomes.
12. Canonicalize and calculate the semantic digest.
13. Validate ContractIR against its schema.
14. Write ContractIR and the capability report atomically.

No server, tool process, behavior backend, or paid agent may start before stages
1–14 succeed under the selected strictness policy.

### 13.3 Canonical operation identity

The canonical key is independent of operationId:

```text
path:<METHOD> <path-template>
```

Example:

```text
path:POST /v1/computers/{computer_id}/restore
```

The UID is:

```text
op_ + first 12 lowercase hexadecimal characters of
SHA-256(UTF-8 canonical operation key)
```

Rules:

- Every key and UID MUST be unique.
- operationId MAY be missing or duplicated.
- A unique operationId matching **^[A-Za-z][A-Za-z0-9_-]{0,63}$** becomes the
  preferred tool name; the original operationId is always retained for display.
- Otherwise the compiler generates a deterministic method/path name.
- A UID suffix resolves any generated-name collision.
- Every generated tool name matches that same 64-character grammar. Truncation
  reserves seven characters for an underscore plus six UID characters.
- Behavior handlers and rubrics SHOULD use canonical keys or UIDs; operation IDs
  remain convenience labels.

### 13.4 Route rules

- All eight explicit path methods are supported as compile targets: GET, PUT,
  POST, DELETE, OPTIONS, HEAD, PATCH, and TRACE.
- No implicit HEAD, OPTIONS, CORS, health, documentation, or admin route is
  added.
- Literal segments win over parameter segments at the same depth.
- Two templates of the same method are ambiguous and fail compilation
  when they have the same depth, neither template is all-literal, and
  every position agrees: both literals are equal, or either side is a
  parameter. This covers templates that differ only in parameter names,
  such as /pets/{id} and /pets/{name}, and templates whose parameter
  position covers a literal position of the other, such as /a/{x}/c and
  /a/b/{y}.
- Templates of different depths, such as /a/{x} and /a/{x}/b, and
  templates with distinct literals at one position, such as /a/{x}/c
  and /a/b/d, never match the same request path. An all-literal
  template never conflicts either: /a/{x} and /a/b compile together,
  and matching prefers the literal route, so the pair is never
  ambiguous.
- Every template parameter must have an effective required path parameter
  declaration.
- Invalid percent encoding is rejected at runtime before behavior.
- A known path with the wrong method returns 405 with Allow and emits a
  matched-path diagnostic.

### 13.5 Parameter rules

- Path-level and operation-level parameters are merged.
- Operation-level parameters override path-level entries with the same name and
  location.
- Effective style, explode, allowReserved, required, schema/content, examples,
  and deprecation are recorded.
- Duplicate query and header values remain ordered arrays in the normalized
  request and trace.
- Header matching is case-insensitive while original value order is preserved.
- Serialization support is reported per parameter; unsupported parameter
  behavior never silently falls back to a different style.

### 13.6 Schema rules

- Recursive schemas remain a graph through schema references.
- OpenAPI 3.0 nullable semantics are normalized.
- Request validation honors readOnly and response validation honors writeOnly.
- Lossy schema conversion emits a stable diagnostic and marks affected
  operations approximated.
- Unsatisfiable schemas, unsupported dialects, and unsupported regex behavior
  become explicit capability outcomes.
- Source JSON Pointers remain attached to normalized schemas and diagnostics.

### 13.7 Security rules

OpenAPI Security Requirement Objects preserve their exact logical semantics:

- The array is OR.
- Schemes inside one object are AND.
- Operation-level security overrides root security.
- An empty requirement permits anonymous access.

Flattening requirements into one list is forbidden.

### 13.8 Response selector rules

- Exact status, such as 201, wins over a range such as 2XX.
- A matching range wins over default.
- Header and content negotiation are compiled per response.
- A response with no content remains a valid empty response.
- Callbacks, webhooks, links, and unsupported constructs are preserved in
  ContractIR even when execution support is unavailable.

### 13.9 Diagnostics

Diagnostic codes are stable API; wording is not.

```json
{
  "severity": "error",
  "code": "OAL-OAS-ROUTE-AMBIGUOUS",
  "message": "Templated routes /pets/{id} and /pets/{name} can match the same request path.",
  "document_uri": "pack://example/contract/openapi.yaml",
  "json_pointer": "#/paths/~1pets~1{id}",
  "operation_key": "path:GET /pets/{id}",
  "retryable": false,
  "related": [
    {
      "document_uri": "pack://example/contract/openapi.yaml",
      "json_pointer": "#/paths/~1pets~1{name}"
    }
  ],
  "details": {
    "method": "GET",
    "templates": ["/pets/{id}", "/pets/{name}"]
  }
}
```

Severity is info, warning, or error. Fatal compiler errors include unresolved
approved references, ambiguous templated routes, invalid path parameter
declarations, malformed parameter serialization, missing required response
objects, and configured resource-limit violations.

### 13.10 Capability outcomes

Every operation has one support level:

- **supported:** execution is implemented without a known semantic approximation
  at the contract layer.
- **approximated:** execution is possible but one or more contract constructs
  are approximated.
- **requires_scenario:** the shape is supported but the selected task requires
  business behavior that only a scenario can supply.
- **unsupported:** safe correct execution is unavailable.

Every non-supported level includes stable reason codes, source pointers, and
affected request/response surfaces. The inspect command recommends:

- Contract mode viability.
- Scenario requirements.
- Direct or catalog tool exposure.
- Strict-run blockers.

### 13.11 Version 0.1 support matrices

#### Parameter serialization

| Location      | Style          | Supported shapes                                                          |
| ------------- | -------------- | ------------------------------------------------------------------------- |
| path          | simple         | primitive, array, flat object; explode false/true                         |
| path          | label          | primitive, array, flat object; explode false/true                         |
| path          | matrix         | primitive, array, flat object; explode false/true                         |
| query         | form           | primitive, array, flat object; explode false/true; repeated keys retained |
| query         | spaceDelimited | primitive arrays only                                                     |
| query         | pipeDelimited  | primitive arrays only                                                     |
| query         | deepObject     | one-level object with primitive or primitive-array properties             |
| header        | simple         | primitive, array, flat object; explode false/true                         |
| cookie        | form           | primitive, array, flat object; explode false/true                         |
| any parameter | content        | one application/json media type                                           |

Nested objects in simple/form/matrix/label serialization and nested deepObject
are unsupported because interoperable wire semantics are not sufficiently
defined for version 0.1. Query allowReserved and query allowEmptyValue are
supported. Parameter examples never override actual validation.

#### Request/response media

| Media family                                 | MVP behavior                                                                                                                                                  |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| application/json and structured suffix +json | Full parse, validation, redaction, and generation.                                                                                                            |
| text/\*                                      | UTF-8 text with charset validation and bounded preview.                                                                                                       |
| application/octet-stream                     | Streaming bytes with bounded retention.                                                                                                                       |
| application/x-www-form-urlencoded            | Form serialization matching schema properties.                                                                                                                |
| multipart/form-data                          | Root object; scalar text, binary string, repeated scalar/binary arrays, per-property encoding contentType, and declared per-part headers.                     |
| application/xml and text/xml                 | Validation/generation approximated; DTD/entities disabled; strict evals require an explicit fixture or scenario unless full XML adapter support is installed. |
| text/event-stream                            | Bounded deterministic SSE response; no unbounded live feed.                                                                                                   |
| Other media                                  | Preserved and reported unsupported unless a pack supplies a validated opaque fixture.                                                                         |

Multipart nested objects are supported only as a JSON part with explicit
application/json encoding. Nested multipart, arbitrary transfer encodings, and
unbounded streams are unsupported.

#### JSON Schema validation

The version 0.1 validator supports the Draft 2020-12 core, applicator,
validation, metadata, format-annotation, content-annotation, and unevaluated
vocabularies needed by OpenAPI 3.1, subject to regex and resource limits.
OpenAPI 3.0 schemas are converted into this form with nullable, discriminator,
readOnly, writeOnly, and exclusive-bound compatibility.

Format is annotation by default. A pack can require assertion for the checked-in
supported format list: date, date-time, time, duration, email, hostname, IPv4,
IPv6, URI, URI-reference, UUID, and common OpenAPI numeric/string formats.
Unknown formats are explicit annotations, not silent assertion failures.

An independent conformance corpus backs these claims. The official JSON Schema
Test Suite, draft 2020-12, is vendored under
`tests/conformance/json-schema-suite` at the revision recorded in its
`manifest.json`, and `tests/json-schema-conformance.test.ts` enforces every
case. A case may be excluded only through a manifest entry that names the
reason, and the runner fails when an exclusion stops failing, so exclusions
cannot outlive the defect they document. Known exclusions:

- `$anchor`, `$dynamicRef`, `$dynamicAnchor`, `dependentSchemas`, and
  `$vocabulary` are not implemented; references resolve as local JSON Pointers
  only, without `$id` or base-URI scope tracking.
- `unevaluatedItems` and `unevaluatedProperties` consider same-object
  evaluators plus adjacent `contains` matches. Annotation collection across
  in-place applicators (`$ref`, `allOf`, `anyOf`, `oneOf`, `not`,
  `if`/`then`/`else`) is not implemented, so those cases are excluded.
- The suite's optional directory is not vendored: format assertion is opt-in by
  design, and the optional files target implementation-specific behavior.

#### Deterministic schema generation

Generation supports:

- type and union types.
- const, enum, default, and safe examples.
- Numeric bounds and multipleOf.
- String length, supported safe pattern subset, and supported formats.
- Array items, prefixItems, min/max items, and uniqueItems.
- Object required/properties, min/max properties, and additionalProperties.
- allOf when the intersection is satisfiable.
- oneOf/anyOf through canonical branch selection followed by validation.
- Discriminator mappings with resolvable branches.
- Recursive schemas within depth/object limits.

Generation requires a fixture/example or reports unsupported for not,
if/then/else, contains constraints that cannot be constructively satisfied,
dependentSchemas with cyclic choice, propertyNames/patternProperties
combinations without a safe constructible key, unevaluated constraints that
cannot be proven after composition, unsafe regex, or an unsatisfiable schema.

#### Capability granularity

Diagnostics attach to the smallest affected surface: parameter, request media
type, response selector/media type, security alternative, callback/webhook, or
schema. Operation support is derived:

- **supported** when every exposed/requestable surface and at least one
  deterministic success response path are full.
- **approximated** when execution remains safe and contract-valid but an
  optional or selected surface has a documented approximation.
- **requires_scenario** when contract shape is executable but the eval declares
  a business invariant contract mode cannot supply.
- **unsupported** when safe routing/validation/serialization or a deterministic
  selected response is unavailable.

Document support is an aggregate only. Strictness applies to the resolved eval
operation scope and participant data-plane scope according to their declared
policy.

## 14. ContractIR

ContractIR is immutable and deterministic. All consumers use it rather than
independently interpreting source OpenAPI.

### 14.1 Top-level shape

```json
{
  "$schema": "https://agentlab.dev/schemas/contract-ir.v1.json",
  "schema_version": 1,
  "kind": "ContractIR",
  "compiler": {
    "name": "@agentlab/openapi",
    "version": "0.1.0"
  },
  "source": {
    "entrypoint": "contract/openapi.json",
    "media_type": "application/json",
    "openapi_version": "3.1.0",
    "sha256": "SOURCE_DIGEST",
    "semantic_sha256": "SEMANTIC_DIGEST",
    "execution_sha256": "EXECUTION_DIGEST",
    "documents": [
      {
        "uri": "pack://steel-computer/contract/openapi.json",
        "sha256": "SOURCE_DIGEST"
      }
    ]
  },
  "api": {
    "title": "Steel Computer API",
    "version": "1.0.0",
    "description": null,
    "servers": []
  },
  "security_schemes": {},
  "schemas": {},
  "operations": [],
  "webhooks": [],
  "diagnostics": [],
  "extensions": {}
}
```

### 14.2 Operation shape

```json
{
  "key": "path:POST /v1/computers",
  "uid": "op_78c844bd7fa4",
  "surface": "path",
  "method": "POST",
  "path_template": "/v1/computers",
  "route_segments": [
    { "kind": "literal", "value": "v1" },
    { "kind": "literal", "value": "computers" }
  ],
  "operation_id": "createComputer",
  "tool_name": "createComputer",
  "summary": "Create a computer",
  "description": null,
  "tags": ["Computers"],
  "deprecated": false,
  "servers": [],
  "parameters": [],
  "request_body": {
    "required": true,
    "content": [
      {
        "media_type": "application/json",
        "schema_ref": "sch_9d03a628318d",
        "examples": []
      }
    ]
  },
  "responses": [
    {
      "selector": "201",
      "description": "Created",
      "headers": [],
      "content": [
        {
          "media_type": "application/json",
          "schema_ref": "sch_628a829d43a8",
          "examples": []
        }
      ]
    }
  ],
  "security": {
    "anonymous": false,
    "alternatives": [
      {
        "schemes": [{ "name": "steelApiKey", "scopes": [] }]
      }
    ]
  },
  "callbacks": [],
  "extensions": {
    "steel.status": "LOCKED",
    "steel.wakes_paused_machine": false
  },
  "source_pointer": "#/paths/~1v1~1computers/post",
  "support": {
    "level": "supported",
    "diagnostic_codes": []
  }
}
```

### 14.3 ContractIR invariants

- Operations are sorted by canonical key.
- Security schemes, schemas, operations, callbacks, webhooks, parameters, media
  types, examples, and source pointers are represented explicitly.
- Maps that are not semantically ordered are serialized in lexicographic order
  for the semantic digest.
- Source order MAY be retained for diagnostics, but runtime behavior MUST use
  canonical ordering or include the ordering in execution_sha256.
- An OpenAPI 3.1 JSON and semantically equivalent YAML document yield the same
  semantic digest and different source digests.
- No source operation is absent because a backend cannot execute it.
- ContractIR is validated against **contract-ir.v1.schema.json** before use.
- A consumer encountering an unknown ContractIR version fails before starting
  any network listener or agent.

## 15. Gateway and contract backend

### 15.1 Request pipeline

The listener first checks the frozen documentation-candidate inventory. A
candidate request follows the bounded documentation-facade pipeline: limit
enforcement, request parsing, declared authentication, visibility-policy
selection, sanitized-byte response or neutral unknown-route response, and one
**documentation.exchange** record. It never enters ContractIR route matching,
behavior, state, idempotency, product-operation counts, or **api.exchange**. All
other requests follow the product pipeline below.

Every product HTTP and tool invocation passes through one logical execution
pipeline:

1. Allocate a run-scoped ingress sequence and request ID.
2. Enforce connection, target, header, and body limits.
3. Parse method, path, query, headers, cookies, and content type.
4. Match a route and method.
5. Parse and deserialize parameters according to OpenAPI style and explode
   rules.
6. Match and verify one declared security alternative.
7. Select and parse the request media type.
8. Validate request parameters and body.
9. Check deterministic fault rules and any pack-declared idempotency policy.
10. Invoke the contract or scenario backend.
11. Select the matching response selector.
12. Validate returned status, headers, media type, and body.
13. Atomically commit state, idempotency record, and normalized event.
14. Serialize and send the response.
15. Flush the exported trace record in ingress order.

Routing, authentication, parsing, and request validation failures skip behavior
but still produce one transactionally stored API exchange event.

### 15.2 Framework response defaults

| Condition                                | Default status | Stable code               |
| ---------------------------------------- | -------------: | ------------------------- |
| Invalid request target or malformed JSON |            400 | request_malformed         |
| Missing or invalid authentication        |            401 | authentication_failed     |
| Authenticated but unauthorized           |            403 | authorization_failed      |
| Unknown path                             |            404 | route_not_found           |
| Known path, wrong method                 |            405 | method_not_allowed        |
| Request target too long                  |            414 | request_target_too_large  |
| Unsupported request media type           |            415 | media_type_unsupported    |
| Request body too large                   |            413 | request_body_too_large    |
| Schema-invalid request                   |            422 | request_schema_invalid    |
| Request/rate quota exceeded              |            429 | request_quota_exceeded    |
| Scenario operation unavailable           |            501 | mock_behavior_unavailable |
| Backend timed out                        |            504 | behavior_timeout          |
| Schema evaluation deadline exceeded      |            504 | OAL-SCHEMA-WORKER-TIMEOUT |
| Schema evaluation failed in its boundary |            500 | OAL-SCHEMA-WORKER-FAILED |
| Backend result violates contract         |            500 | mock_response_invalid     |
| State transaction failed to commit       |            500 | OAL-STATE-COMMIT-FAILED   |
| Unexpected internal failure              |            500 | internal_error            |

Framework errors SHOULD use RFC 9457 **application/problem+json** with stable
**code** and **request_id** extensions. A pack MAY provide contract-shaped error
templates. The normalized trace error remains framework-owned and stable.

No stack trace, host path, internal exception, SQL text, or executable module
detail may be returned to the participant.

### 15.3 Request validation

The gateway MUST validate:

- Required path, query, header, and cookie parameters.
- Effective style, explode, and allowReserved behavior.
- Parameter content schemas where used.
- Required or forbidden bodies.
- Content-Type and Accept negotiation.
- JSON, text, octet-stream, URL-encoded form, and supported multipart bodies.
- Request JSON Schema with request-side readOnly handling.
- Declared security requirements.

Validation errors use stable violation records:

```json
{
  "location": "body",
  "pointer": "/template",
  "code": "required",
  "message": "Required property is missing."
}
```

The gateway MUST validate the complete request before any domain mutation.

### 15.4 Response validation

Before state commit, the gateway MUST:

- Match exact status, range, then default.
- Validate required response headers.
- Validate the selected media type.
- Validate response JSON Schema with response-side writeOnly handling.
- Verify empty versus present body semantics.
- Enforce response size limits.

Under **response_validation: error**, an invalid backend result rolls back and
becomes 500 **mock_response_invalid**. Under a future warning mode, the response
may be sent but the approximation is explicit. Evaluation packs MUST use error
mode.

String patterns are satisfied by bounded synthesis (section 15.6) or by a fixed
literal shortcut. The synthesizer supports anchors, disjunctions, groups,
character classes with ranges and negation, counted quantifiers, and identity
escapes; it refuses lookarounds, backreferences, named groups, inline flags,
unicode property escapes, word boundaries outside classes, and any expression
beyond its size caps. A pattern the synthesizer refuses stays 501
**mock_behavior_unavailable**; it never degrades to 500.

### 15.5 Contract response selection

The contract backend chooses a response deterministically.

Status precedence:

1. Pack-configured operation fixture or status.
2. 200.
3. 201.
4. 202.
5. 204.
6. Lowest other explicit 2xx status.
7. A declared 2XX range, emitted as concrete status 200.
8. Startup failure in strict mode or 501 **mock_behavior_unavailable**
   (section 15.2) in partial mode.

A default response is not intrinsically success and is never selected as an
automatic success. A pack fixture may choose a concrete status whose schema is
supplied by default. Other range selectors use the lowest concrete status in
their class only when a framework/domain error explicitly selects that class.

Response-value precedence:

1. Configured operation and media-type fixture.
2. Explicit configured named example.
3. Singular media-type example.
4. Lexicographically first named media-type example.
5. Schema example.
6. Schema const.
7. Schema default.
8. First enum value in ascending canonical-JSON byte order.
9. Deterministic schema generation.

An example candidate whose value fails the section 15.4 body check against the
declared response schema is skipped in favor of the next candidate. The served
value records its provenance, and skipped candidates are recorded as an
approximation. When every candidate is skipped, deterministic schema
generation (rule 9) produces the value. Only when no generation path exists —
the content entry declares no schema — is the highest-precedence candidate
served, and section 15.4 then applies to it unchanged. Contract response
fixtures (section 15.5.1) are exempt: a fixture is pack-authored data and
fails closed under 15.4.

The trace records selected status, media type, value provenance, and any
approximation.

#### 15.5.1 Contract response fixtures

An optional pack fixture has this shape:

```yaml
contract:
  response_fixtures:
    - id: create-example
      operation: "path:POST /v1/widgets"
      status: 201
      media_type: application/json
      headers:
        location: /v1/widgets/widget_0001
      body:
        kind: json_file
        source: fixtures/responses/create-widget.json
```

Supported body kinds are **none**, **json_inline**, **json_file**,
**text_file**, and **binary_file**. Rules:

- At most one default fixture exists per operation in version 1.
- Status is a concrete final status from 200 through 599 and must match an
  exact, range, or default response declaration.
- Media type and headers must conform to that response.
- File sources resolve inside the pack root and are frozen.
- Body is validated before server startup.
- Fixtures contain no templates, executable expressions, or real secrets.
- Contract fixtures are unconditional. Request-dependent behavior belongs in a
  scenario backend.
- If no fixture exists, normal example/schema selection applies.

### 15.6 Deterministic schema generation

Generation MUST:

- Respect required properties.
- Respect const, enum, type, nullability, minimum, maximum, exclusive bounds,
  multipleOf, minLength, maxLength, pattern when safely supported, format,
  minItems, maxItems, uniqueItems, minProperties, and maxProperties.
- Generate stable object property order.
- Generate bounded arrays and strings where the schema is unbounded.
- Handle supported allOf, oneOf, anyOf, discriminator, prefixItems,
  additionalProperties, and recursive schemas.
- Choose among multiple otherwise valid oneOf/anyOf branches by ascending
  canonical schema digest; never by parser/source iteration order.
- Produce reserved-domain URLs, such as example.invalid, rather than real
  services.
- Produce unmistakably synthetic credential-like values.
- Use virtual time for date and date-time.
- Use namespaced deterministic generators so unrelated operations do not perturb
  one another.
- Validate the generated result before sending it.

Unsupported or ambiguous composition MUST fail strict generation or emit an
explicit approximation. The generator MUST never emit an invalid response merely
to keep a server running.

### 15.7 Content negotiation

- Media types are parsed case-insensitively.
- Accept quality factors and specificity are honored.
- A deterministic stable tie-breaker uses lexical lowercase media type.
- A missing Accept permits the backend’s deterministic preferred representation.
- A request with an unsupported Content-Type returns 415.
- A request whose Accept cannot be satisfied returns 406
  **response_media_type_unacceptable**.

### 15.8 HTTP wire semantics

- A declared HEAD operation is routed only when explicitly present. Its
  candidate representation is validated, but no response body bytes are sent;
  Content-Length may describe the selected representation when deterministically
  known.
- Status 204 and 304 send no body regardless of an invalid source example;
  strict compilation diagnoses a contradictory body schema/example.
- Informational 1xx responses are represented in ContractIR but are unsupported
  as the sole final contract-mode response in version 0.1.
- Multiple Set-Cookie fields and other non-combinable headers remain separate
  values.
- Hop-by-hop headers are controlled by the gateway and cannot be supplied by
  fixtures/behavior.
- Path matching does not filesystem-normalize dot segments. Percent decoding
  happens exactly once after bounded syntax validation.
- JSON uses UTF-8. A declared incompatible charset is a capability error.
- SSE emits deterministic event order, IDs, retry fields, data bytes, and
  termination under configured bounds.

### 15.9 Authentication emulation

Version 0.1 supports:

- API key in header, query, or cookie.
- HTTP Basic.
- HTTP Bearer.
- Dummy OAuth 2.0 and OpenID Connect bearer tokens without a real authorization
  server.

The capability report describes unsupported flows such as mutual TLS, dynamic
OpenID discovery, or OAuth authorization-server execution.

Each run receives unique synthetic credentials. The gateway evaluates the
OpenAPI security expression and passes only a verified principal to behavior.
Raw credential values never enter behavior state.

Harness-level tenant isolation MUST be separate from the tested API’s declared
authentication. The mock must not impose an undeclared participant-visible
header.

### 15.10 Safe side-effect policy

Contract mode treats all operations as representations. An operation named exec,
shell, SSH, browser, URL upload, callback, webhook, email, or payment receives
no special host capability.

- Command-shaped payloads are data and never spawn a process.
- URL-shaped payloads are data and never trigger DNS or outbound traffic.
- File-shaped paths are virtual identifiers and never resolve against the host
  filesystem.
- Callback and webhook definitions are preserved but not invoked.
- Links may be described but do not cause follow-up requests.

### 15.11 Response and documentation profiles

Framework-controlled participant behavior is data, not scattered string
literals. **response-profile.v1.schema.json** freezes:

- Unknown-route, wrong-method, authentication, authorization, parse, validation,
  limit, timeout, and internal-error status/body/header catalogs.
- Identifier, base-URL, and generated-credential shape rules without resolved
  secret values.
- Which request facts may be rendered into an error and their bounded escaping
  policy.
- Content type, maximum bytes, localization version, and any intentionally
  visible compatibility header.

The default **neutral-v1** profile uses no product, OAL, mock, experiment,
variant, file, framework, operation-hint, stack, or corrective-strategy label.
It adds no **x-oal-\*** or mock-message header. Contract-declared domain
responses still come from the contract/backend; a response profile cannot loosen
validation, change domain status selection, or reveal hidden state.

**documentation-profile.v1.schema.json** freezes candidate method/path pairs,
index/contract role, enabled subset, authentication policy, content type,
headers, index-link ordering, disabled-candidate outcome, size ceiling, and
response-profile reference. Version 1 candidates are GET-only. A contract
candidate serves the already localized sanitized bytes; an index contains only
declared candidate links. Profile validation rejects duplicate routes,
parameterized candidates, product-route collisions, redirects, remote assets,
stateful behavior, dynamic path discovery, and control-plane targets.

Profiles are compiled before listener startup, included in
ParticipantSurfaceManifest and cell/implementation identity, and rendered with
the same strict bounded substitution engine. A StudyProtocol varying one profile
declares the exact factor-owned differences; otherwise profile drift fails
analytical preflight.

## 16. Behavior backend

### 16.1 Responsibility split

The gateway owns:

- Routing.
- Deserialization.
- Authentication.
- Request validation.
- Response serialization and validation.
- Framework errors.
- Limits and timeouts.
- State transaction boundaries.
- Idempotency persistence.
- Trace construction.
- Blob persistence.

The behavior backend owns:

- Initial JSON domain state.
- Operation-specific domain guards and effects.
- Contract-shaped domain responses.
- Small redacted evidence projections.

### 16.2 TypeScript interface

```ts
export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };

export type Body =
  | { kind: "none" }
  | { kind: "json"; value: Json }
  | { kind: "text"; text: string; sizeBytes: number; sha256: string }
  | { kind: "binary"; bytes: Uint8Array; sizeBytes: number; sha256: string }
  | { kind: "multipart"; parts: MultipartPart[] };

export interface BackendModule {
  apiVersion: 1;
  name: string;
  version: string;
  create(context: BackendFactoryContext): Promise<BehaviorBackend>;
}

export interface BackendFactoryContext {
  readonly contract: ContractIR;
  readonly packRoot: string;
  readonly config: Json;
}

export interface BehaviorBackend {
  describe(): Promise<BackendDescription>;
  initialize(context: InitializeContext): Promise<InitializeResult>;
  handle(
    request: BehaviorRequest,
    context: HandleContext
  ): Promise<BehaviorResult>;
  project?(
    state: Readonly<Json>,
    request: BehaviorRequest | null
  ): Promise<Json>;
  close?(): Promise<void>;
}

export interface BackendDescription {
  backendApiVersion: 1;
  stateSchemaVersion: number;
  operations: Array<{
    key: string;
    support: "implemented" | "passthrough" | "unsupported";
  }>;
  semanticEvents?: Array<{
    name: string;
    eventVersion: number;
    payloadSchema: Json;
  }>;
}

export interface InitializeContext {
  readonly runId: string;
  readonly fixtures: ReadonlyArray<Json>;
  readonly clock: DeterministicClock;
  readonly ids: DeterministicIds;
  readonly random: DeterministicRandom;
  readonly blobs: BlobStore;
}

export interface InitializeResult {
  state: Json;
  observations?: Json;
}

export interface BehaviorRequest {
  readonly operation: ContractOperation;
  readonly principal: Json | null;
  readonly parameters: {
    path: Readonly<Record<string, Json>>;
    query: Readonly<Record<string, Json>>;
    header: Readonly<Record<string, Json>>;
    cookie: Readonly<Record<string, Json>>;
  };
  readonly body: Body;
  readonly selectedRequestMediaType: string | null;
  readonly acceptedResponseMediaTypes: ReadonlyArray<string>;
}

export interface HandleContext {
  readonly runId: string;
  readonly requestId: string;
  readonly state: Readonly<Json>;
  readonly clock: DeterministicClock;
  readonly ids: DeterministicIds;
  readonly random: DeterministicRandom;
  readonly blobs: BlobStore;
}

export interface BehaviorResult {
  response: {
    status: number;
    headers?: Array<{ name: string; values: string[] }>;
    mediaType?: string;
    body?: Body;
  };
  nextState?: Json;
  effects?: string[];
  observations?: Json;
  semanticEvents?: Array<{
    name: string;
    eventVersion: number;
    payload: Json;
  }>;
}
```

### 16.3 Backend semantics

- Version 0.1 handles behavior requests serially per run in ingress order.
- **context.state** is immutable state at transaction start.
- State changes require a returned **nextState**.
- State MUST be JSON-serializable and pass the configured state size and schema
  checks.
- Initial state and every returned nextState MUST validate against the pack’s
  Draft 2020-12 state schema before commit.
- A successful response with no nextState leaves state unchanged.
- A declared BehaviorHttpError returns its contract-shaped HTTP failure and
  rolls back state.
- A BehaviorHttpError cannot commit state in backend API version 1.
- Any other exception rolls back and becomes generic 500
  **behavior_internal_error**.
- The response is validated before nextState commits.
- Declared semantic events, nextState, response outcome, idempotency record, and
  parent API exchange commit or roll back in one SQLite transaction.
- Semantic events MUST match the backend registry, validate against their pinned
  payload schemas, and pass redaction before commit. A failed, rolled-back,
  timed-out, replayed, or invalid-response request emits no duplicate committed
  fact.
- Behavior receives deterministic services and SHOULD NOT call Date.now,
  Math.random, randomUUID, the filesystem, or network independently.
- Large binary state belongs in BlobStore and is referenced by digest.
- Behavior never receives raw credentials.
- **describe()** runs before the listener starts.
- Under exact completeness, missing and extra operation keys are fatal.
- Restart is permitted only when run ID, ContractIR semantic and execution
  digests, source inventory, pack, scenario, ContractVariant, backend bundle,
  implementation, state-schema version, and seed match.
- State migration is out of scope for backend API version 1.
- **effects** is a bounded convenience list of semantic event names; the
  separately persisted semantic-event records are authoritative when present.

### 16.4 Behavior errors

```ts
throw new BehaviorHttpError({
  status: 409,
  code: "invalid_state",
  message: "Cannot pause a stopped computer.",
  body: {
    kind: "json",
    value: {
      error: {
        code: "invalid_state",
        message: "Cannot pause a stopped computer."
      }
    }
  }
});
```

The participant receives the declared body, not backend implementation details.
The normalized trace records layer **behavior**, stable code, retryability, and
redacted details.

### 16.5 Runtime isolation

Safe contract mode runs no behavior module.

Executable behavior modules:

- MUST run outside the controller process.
- Receive a minimal environment with no provider or host credentials.
- Communicate through a versioned length-bounded IPC protocol.
- Receive only frozen public contract metadata, validated request data,
  deterministic services, and scoped state.
- MUST be terminated with the run.
- Are marked **trusted-local** unless an OS/container/WASM boundary enforces
  filesystem, process, and network restrictions.

Official built-in packs may run in trusted-local mode for the first local
release, but reports MUST record the effective isolation level. Hosted execution
requires isolated-extension mode and cannot accept trusted-local.

### 16.6 Deterministic fault rules

Scenarios MAY declare bounded declarative faults:

```yaml
faults:
  - id: first-create-rate-limit
    operation: "path:POST /v1/computers"
    phase: before_behavior
    match:
      occurrence: 1
    action:
      kind: response
      status: 429
      media_type: application/problem+json
      headers:
        retry-after: "1"
      body:
        type: https://agentlab.dev/problems/rate-limited
        title: Rate limited
        code: fault_rate_limited

  - id: third-download-disconnect
    operation: "path:GET /v1/computers/{computer_id}/files/content"
    phase: after_behavior
    match:
      occurrence: 3
    action:
      kind: disconnect
      after_bytes: 128
```

Version 1 matchers may use:

- Exact occurrence number or bounded list.
- Request parameter/body predicate in the restricted expression engine.
- Seeded probability with a rule-specific PRNG namespace.
- A bounded virtual-time window.

Actions are:

- **response:** bypass behavior and return a configured response.
- **disconnect:** close before headers or after a bounded byte count.
- **timeout:** hold until the gateway’s configured backend/transport timeout.
- **corrupt_candidate:** test response validation internally; never allowed in a
  published participant eval unless the expected result is a framework 500.

Rules:

- Fault IDs are unique and frozen.
- Matching order is declaration order; the first matching terminal action wins.
- Occurrence counters are per rule, per run, and transactionally persisted.
- A before-behavior terminal fault does not mutate domain state.
- An after-behavior fault rolls back behavior state in backend API version 1
  unless the action is an ordinary validated response and the pack explicitly
  selects **commit_behavior: true**.
- Fault response candidates are contract-validated unless marked framework
  synthetic.
- Real delay is used only for timeout testing and bounded by the request
  timeout. Other time effects use virtual time.
- Trace records rule ID, phase, match inputs, action, and state commit outcome.
- Fault configuration changes scenario digest and experiment-cell identity.

## 17. Deterministic state and persistence

### 17.1 SQLite source of truth

Each run has a private SQLite database with, at minimum:

- **run_meta**
- **participant_ingress**
- **domain_state**
- **requests**
- **events**
- **semantic_events**
- **documentation_exchanges**
- **idempotency**
- **blobs**
- **export_status**

One transaction for a request MUST include:

- Participant-ingress allocation/linkage when actor is participant.
- Ingress sequence allocation.
- Parsed operation identity.
- Request validation outcome.
- Idempotency lookup or insertion.
- Before-state revision and digest.
- Domain transition.
- Response selection and validation.
- After-state revision and digest.
- Normalized event persistence.
- Schema-valid semantic-event persistence.

The response is sent only after the transaction commits. If commit fails, the
participant receives a bounded 500 and the run becomes infrastructure-invalid.

Documentation exchanges use a separate transaction and sequence because they
cannot read or mutate domain state. Their persistence failure is still
infrastructure failure and cannot be misreported as absence of participant
discovery.

### 17.2 State revisions

- State revision starts at zero after initialization.
- It increments only when committed nextState differs from prior state.
- Failed, rejected, unauthorized, invalid, or rolled-back requests retain the
  same before/after revision and digest.
- Full mutable state is not repeated in every event.
- Behavior may return a small redacted projection for evidence.
- Final state is exported atomically after the listener closes.

### 17.3 Idempotency

Idempotency is disabled in bare contract mode and for every operation without an
explicit pack policy. The presence of a header named Idempotency-Key in OpenAPI
does not authorize the lab to infer replay semantics.

Each policy declares:

- One or more canonical operation keys.
- Key location and wire name; version 1 supports header keys.
- Whether the authenticated principal participates in scope.
- Cacheable concrete statuses or status classes.
- Whether domain failures are cached.
- None or virtual-clock TTL.
- Per-run entry limit.
- Conflict status and contract-shaped error fixture when required.

Policy validation fails when an operation is unknown, a key parameter conflicts
with contract serialization, the configured conflict response cannot be
represented, or two policies overlap one operation.

Idempotency cache identity includes:

- Canonical operation key.
- Verified principal or synthetic tenant.
- Normalized path parameters.
- Idempotency key.

Reusing the same identity with a different normalized request body SHOULD return
409 **idempotency_conflict**. A valid replay returns exactly the original
contract-visible status, body, and headers and does not repeat state mutation.

The trace records whether a response was new, replayed, or conflicted.

Missing keys pass through normally unless a policy explicitly requires one.
Expiry uses virtual time. Eviction order is expired first, then oldest committed
sequence. Idempotency storage is per run and is never shared.

### 17.4 Virtual clock

- Default logical epoch is 2000-01-01T00:00:00.000Z.
- Each committed request advances logical time by one millisecond unless a
  scenario explicitly advances it differently.
- Expiry, generated dates, and domain time use virtual time.
- Real received/completed timestamps and monotonic duration remain observational
  fields.
- Wall time never affects mock behavior or deterministic grading.
- Scenarios use explicit virtual-time actions rather than sleep.

### 17.5 Seed derivation

The runner hashes a canonical JSON object, never delimiter-free string
concatenation:

```json
{
  "schema_version": 1,
  "contract_execution_sha256": "EXECUTION_DIGEST",
  "participant_surface_template_sha256": "PARTICIPANT_TEMPLATE_DIGEST",
  "pack_sha256": "PACK_DIGEST",
  "scenario": {
    "id": "baseline",
    "sha256": "SCENARIO_DIGEST"
  },
  "behavior_sha256": "BEHAVIOR_DIGEST",
  "eval": {
    "id": "checkpoint-recovery",
    "sha256": "EVAL_DIGEST"
  },
  "case": {
    "id": "default",
    "sha256": "CASE_DIGEST"
  },
  "cohort_seed": "steel-baseline-2026-08-27",
  "assignment": {
    "kind": "ordinary_repetition",
    "index": 0
  }
}
```

The lowercase SHA-256 of canonical UTF-8 bytes is the run seed.
**assignment.kind** is **ordinary_repetition**, **primary**, or
**held_replacement** and domain-separates its nonnegative index. Seed derivation
uses the pre-localization participant-surface template digest, never the
rendered manifest containing values derived after seed selection. The batch
generates and freezes one 256-bit cohort seed when the operator omits
**--cohort-seed**.

Manual **oal serve --run-seed** supplies the direct run seed. Without it, manual
serve hashes a separate canonical tuple containing contract execution digest,
pack/scenario/backend digests, and run ID. A cohort seed is never interpreted as
a direct run seed.

Separate PRNG namespaces exist for IDs, UUIDs, generated strings, tokens, schema
branches, faults, and fixtures. Adding an unrelated generator call in one
namespace MUST not perturb another.

### 17.6 Concurrency

- Version 0.1 serializes stateful execution in ingress-sequence order.
- Parallel connections may parse bounded request framing concurrently but queue
  before stateful validation/behavior.
- The queue is bounded and applies backpressure.
- Strict deterministic mode MAY reject simultaneous state-changing requests with
  a stable 409 or 429, but MUST not race mutations.
- Parallelism across trials remains an experiment variable and MUST be recorded.

## 18. Agent exposure interfaces

### 18.1 Shared invocation envelope

Direct and catalog tools normalize inputs into:

```json
{
  "operation": "path:POST /v1/computers",
  "parameters": {
    "path": {},
    "query": {},
    "headers": {},
    "cookies": {}
  },
  "contentType": "application/json",
  "accept": ["application/json"],
  "body": {}
}
```

They return:

```json
{
  "status": 201,
  "headers": [
    {
      "name": "content-type",
      "values": ["application/json"]
    }
  ],
  "body": {},
  "contentType": "application/json",
  "requestId": "req_00000001"
}
```

Authentication is injected by the bridge. Credential values never appear in tool
arguments, descriptions, or transcripts.

Parameters that implement a declared security scheme are omitted from generated
tool input schemas. If an untyped catalog invocation attempts to supply one, the
bridge rejects it with **protected_auth_parameter** rather than logging or
forwarding it.

Binary bodies are bounded base64 in tool transport and include content type,
byte count, and SHA-256. Large output truncation follows a frozen policy and
includes a complete-byte digest.

### 18.2 Direct tool naming

1. Use a unique tool-valid operationId.
2. Otherwise use a deterministic method and sanitized path name.
3. Add a six-character UID suffix on collision.
4. Freeze the complete operation-to-tool map in batch inputs.
5. Fail preflight if the target adapter’s naming constraints cannot be met.

Tool descriptions derive only from source contract data plus neutral
serialization guidance. Hidden scenario or grader information MUST NOT be
included.

Generator-owned text defines tool behavior and argument semantics. Source
summary/description text is length-bounded, normalized as plain text, and placed
under an explicit “untrusted contract description” label. It cannot add tools,
change authentication injection, request host capabilities, or override runner
policy.

### 18.3 Catalog search

**search_operations** input:

```json
{
  "query": "create a computer",
  "limit": 10,
  "methods": ["POST"],
  "tags": ["Computers"]
}
```

Each result contains:

- Canonical key and UID.
- operationId when present.
- Method and path.
- Summary.
- Tags.
- Support level.
- Deterministic lexical score.

Search result ordering is score descending, then canonical key ascending. The
tokenizer, field weights, stemming policy, stop-word list, and version are
frozen and recorded.

Version 1 search algorithm:

1. Normalize text to Unicode NFKC and lowercase.
2. Split camelCase, snake_case, kebab-case, punctuation, and whitespace.
3. Retain path literals and HTTP method as tokens; drop path-parameter braces.
4. Apply a checked-in, versioned English stop-word list. Do not stem and do not
   use locale-dependent collation.
5. Limit query to 32 tokens and indexed field to 4,096 tokens per operation.
6. Score each query token against each field: exact token match is 100 times
   field weight; token-prefix match is 25 times field weight; otherwise zero.
7. Add 200 times field weight for an exact normalized query phrase within the
   field.

Initial field weights:

| Field                          | Weight |
| ------------------------------ | -----: |
| operationId/tool name          |     10 |
| HTTP method                    |      8 |
| Path literal                   |      8 |
| Summary                        |      6 |
| Tag                            |      5 |
| Parameter name                 |      4 |
| Request/response property name |      3 |
| Description                    |      1 |

Scores are integers. Ties use canonical-key Unicode code-point order. The
capability/support filter is applied before limit. Any later ranking change
increments the search algorithm version and defines a separate tool-exposure
treatment.

### 18.4 Catalog describe

**describe_operation** input:

```json
{
  "operation": "createComputer",
  "detail": "full"
}
```

Detail is summary, schemas, examples, or full. The result may include:

- Parameters grouped by location.
- Request media types and schemas.
- Response selectors, media types, headers, and schemas.
- Security alternatives.
- Examples.
- Deprecation.
- Source description.
- Capability limitations.

### 18.5 Catalog invoke

**invoke_operation** uses the shared invocation envelope and the same gateway
execution pipeline. It cannot bypass auth, validation, limits, faults,
persistence, tracing, or response validation.

### 18.6 MCP lifecycle

- Every trial receives a unique MCP configuration and process or in-process
  bridge.
- Configuration lives only in the synthetic participant home or declared
  workspace.
- A chosen adapter must advertise MCP support during probe.
- Preflight fails if the configuration cannot be isolated.
- Tool transport errors are recorded separately from API response errors.
- MCP emits the same **api.exchange** event schema with transport kind
  **mcp-direct** or **mcp-catalog**.

## 19. Participant material and prompts

### 19.1 Prompt roles

A run has three distinct prompt roles:

- **instructions:** safety and behavioral constraints, delivered through a
  native instruction channel when supported or a declared participant file.
- **task:** complete outcome-oriented work request, normally materialized as
  TASK.md.
- **launch:** short user message or stdin that begins the agent run.

The core, not an adapter, renders and materializes participant files.

A **PromptSet** owns instructions and launch text plus optional files common to
every eval using it. An **Eval** owns the task, scenario, operation scope,
eval-specific participant files, result contract, rubric, cases, and optional
workflow. Resolution order is:

1. Load one named PromptSet.
2. Add its declared participant files.
3. Add the Eval task at its declared target.
4. Add Eval participant files.
5. Reject duplicate target paths unless the bytes are identical and both
   declarations explicitly allow deduplication.
6. Render all templates with one immutable variable context.

No implicit instructions, task, launch text, or result-schema file is added.
PromptSet and Eval are separately versioned/digested within the pack digest.

### 19.2 Template variables

Version 1 allows a strict allowlist:

```text
pack.name
pack.version
eval.id
run.id
run.index
run.seed
api.baseUrl
api.contractFile
exposure.mode
contract.visibility
case.name
case.input.<declared-key>
```

Rules:

- Every instructions, task, and launch source declares **engine: literal** or
  **engine: mustache-strict**; there is no inferred templating mode.
- Unresolved variables are fatal.
- Secret values are unavailable.
- Substitution is literal.
- No JavaScript, shell, file read, environment read, include, helper,
  reflection, or network function exists.
- Source and rendered digests are both frozen.
- Document-derived descriptions and examples are delimited and labeled untrusted
  contract data when inserted into prompts.
- OpenAPI descriptions are never interpreted as operator, system, or developer
  instructions.
- Participant-file entries default to byte-for-byte **copy** and are never
  rendered unless they explicitly declare a text engine.
- Under strict blinding, templates may technically reference run or exposure
  variables only when the resulting surface entry is explicitly treatment-owned.
  Protocol, phase, assignment, factor, level, cell, variant, replacement, and
  analyzer identifiers are unavailable to the template context.
- A rendered run ID or environment name that reveals assignment, ordering,
  replacement status, or research purpose fails strict participant-surface
  validation.

### 19.3 Participant workspace

The participant receives only declared materials, for example:

```text
workspace/
  openapi.json
  AGENTS.md
  TASK.md
  result.schema.json
```

When contract visibility is file, **openapi.json** is a generated sanitized
single-document bundle:

- Every approved external reference is internalized while preserving recursive
  reference identity.
- All root-, path-, operation-, callback-, and webhook-level server objects are
  rewritten or removed according to data-plane policy.
- Sensitive examples/defaults are removed or replaced with synthetic values.
- Operations outside a filtered data-plane scope are removed only from this
  derived participant bundle and remain in the frozen source/ContractIR.
- The bundle is recompiled in a verification pass and MUST map byte-for-byte to
  the expected scoped canonical operation keys, serializers, security
  requirements, and response selectors.
- Its source inventory, transformation version, and digest are frozen.

The participant never receives a broken entrypoint that refers to omitted files.
A future tree-preserving copy mode requires the same sanitization and
verification for every referenced document.

The workspace MUST NOT contain:

- Original production server URLs when server rewriting is enabled.
- Pack source or manifest unless explicitly declared.
- Behavior implementation.
- Initial state or fixtures.
- Hidden workflows.
- Rubric or expected outcomes.
- Trace, state database, or evaluation.
- Sibling workspaces.
- Provider credentials.

The workspace SHOULD be initialized as a fresh Git repository when the selected
agent discovers repository-bound instruction files.

The runner compiles and freezes **participant-surface-manifest.json** before
materialization. Workspace files are only one part of it; contract-discovery
routes, response catalogs, environment names, credential shapes, tools, and
adapter messages are included even though they are not files. Post-run
verification compares the archived workspace and captured participant channels
to that manifest. An undeclared surface is invalid evidence.

### 19.4 Prompt sets

A pack MAY define multiple named prompt sets, such as diagnostic, minimal, or
naturalistic. Each declares **purpose_disclosure: diagnostic | naturalistic**.
Prompt choice is an experiment variable. The lab MUST NOT silently add hints
such as “read the OpenAPI file,” “use curl,” or “report assumptions.”
Naturalistic mode also forbids framework-added experiment/evaluator language and
strategy cues; diagnostic mode may include them only in frozen authored
material.

### 19.5 Structured output

When an adapter supports a native output schema, the runner SHOULD supply the
declared schema through that native mechanism and still copy the schema file
when the eval declares it participant-visible.

The evaluator always validates the persisted final output itself. Native
structured output is an agent aid, not proof of validity.

An Eval result source is exactly one of:

- **adapter_final:** parse the adapter’s declared final message/output channel.
- **workspace_file:** read one safe relative filename declared as
  **result.filename** after the agent exits.

There is no implicit fallback between sources. For adapter_final, the runner
preserves bounded redacted text, parses JSON once with duplicate-key rejection,
and writes **participant-report.json** only on success. For workspace_file, the
runner rejects traversal, symlink, non-regular file, oversize, and post-exit
mutation; it then applies the same parse/redaction path. Missing, invalid, or
schema-invalid output remains task evidence, not adapter infrastructure failure.

## 20. Arazzo workflows

### 20.1 Roles

Arazzo may provide:

1. Participant guidance.
2. Hidden trace-alignment guidance for deterministic grading.
3. A scripted control baseline outside agent trials.

Every workflow reference declares visibility. Hidden is default.

### 20.2 Validation

The Phase 8 compiler targets Arazzo 1.1.x. Other versions receive an explicit
capability diagnostic until a version adapter is implemented.

The Arazzo compiler maps operation references to canonical ContractIR keys and
validates:

- Supported Arazzo version.
- Source descriptions.
- Workflow and step IDs.
- Step dependencies.
- Operation references.
- Parameter and request mappings.
- Output expressions.
- Success criteria.
- Supported runtime-expression subset.

Unsupported expressions fail strict eval validation rather than being ignored.

### 20.3 Trace alignment

Hidden grading:

- Processes dependency order.
- Searches normalized events in sequence order.
- Supports backtracking rather than greedily consuming an incidental early
  event.
- Resolves declared outputs from matched request/response values.
- Evaluates supported success criteria.
- Reports unmatched, ambiguous, skipped, and failed steps separately.
- Never makes an API call on behalf of the participant.

Arazzo is not a complete state oracle. Pack rubrics remain responsible for
ownership, persistence, cleanup, cost, negative claims, and business invariants.

### 20.4 Control execution

A future or later-MVP command may run a workflow directly:

```sh
oal workflow run ./pack --workflow happy-path
```

This creates a scripted control run and never belongs to an agent cohort unless
explicitly compared as a different treatment.

## 21. Agent adapter API

### 21.1 Interface

```ts
export interface AgentCapabilities {
  nativeSystemPrompt: boolean;
  nativeOutputSchema: boolean;
  mcp: boolean;
  machineReadableTranscript: boolean;
  usageReporting: boolean;
  separateToolEnvironment: boolean;
  enforceableToolNetworkPolicy: boolean;
  sandboxModes: string[];
}

export interface AgentAdapter {
  readonly id: string;
  probe(config: AgentConfig): Promise<AgentProbe>;
  prepare(context: AgentRunContext): Promise<PreparedAgent>;
  run(
    prepared: PreparedAgent,
    sink: AgentEventSink,
    signal: AbortSignal
  ): Promise<AgentRunResult>;
  cleanup?(prepared: PreparedAgent): Promise<void>;
}

export interface AgentRunContext {
  runId: string;
  workspaceDir: string;
  syntheticHomeDir: string;
  temporaryDir: string;
  prompts: {
    instructions?: string;
    task: string;
    launch: string;
  };
  resultSchemaPath?: string;
  exposure: ExposureDescriptor;
  launcherEnvironment: Record<string, string>;
  toolEnvironment: Record<string, string>;
  toolExecutionPolicy: {
    inheritEnvironment: "none";
    allowedEnvironmentNames: string[];
    network: "mock-only" | "deny" | "advisory";
    filesystem: "workspace-only" | "read-only" | "advisory";
  };
  model?: string;
  effort?: string;
  timeoutMs: number;
  sandbox?: string;
}

export interface AgentRunResult {
  status:
    | "completed"
    | "failed"
    | "timed_out"
    | "cancelled"
    | "provider_failed";
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  finalText?: string;
  finalJson?: unknown;
  usage?: Record<string, number>;
  errorCode?: string;
}
```

The adapter does not receive the artifact root, state database, trace, behavior,
fixtures, or rubric.

**launcherEnvironment** is controller-to-agent-driver configuration and may
contain a provider credential required to start the agent. **toolEnvironment**
is the only environment permitted for model-generated commands and contains
participant-visible dummy API credentials but no provider secret. Both are built
by the runner; the adapter MUST NOT merge them.

Resolved launcher values are sensitive and never recorded. Run metadata records
only launcher/tool environment variable names and the adapter’s declaration of
whether it enforces the separation. If the selected CLI makes launcher variables
readable by generated commands, **separateToolEnvironment** is false and the run
cannot claim hard isolation.

### 21.2 Adapter requirements

Adapters MUST:

- Probe availability and capabilities without a paid run.
- Report executable or SDK version.
- Spawn with an argv array, never an interpolated shell string.
- Use a dedicated process group or equivalent.
- Terminate the complete descendant tree on timeout, cancellation, or
  completion.
- Escalate from graceful termination to force termination after a bounded
  interval.
- Retain raw stdout/stderr only in bounded memory long enough to parse it, emit
  normalized session events, and persist redacted streams. Persisting encrypted
  raw capture requires the explicit research mode in section 30.5.
- Distinguish CLI/provider infrastructure failure from an agent answer that
  fails the task.
- Declare required launcher environment variable names.
- Apply exactly the supplied toolEnvironment to generated commands when the
  agent architecture permits it; never fall back to launcher-environment
  inheritance.
- Report whether launcher/tool environment separation and tool network policy
  are enforced or advisory.
- Never persist credential values.
- Identify the participant’s final answer without rewriting it.
- Record exact effective argv after secret-free expansion.

### 21.3 Generic command adapter

The generic adapter accepts:

- Executable path.
- Array of fixed arguments and documented placeholders.
- Working-directory policy.
- Stdin policy.
- Transcript parser.
- Final-output source.
- Capability declaration.

It MUST NOT accept arbitrary shell snippets. Placeholder expansion is limited to
declared prompt and path tokens and always becomes a discrete argv element.

### 21.4 Codex CLI adapter

The reference Codex adapter MUST feature-probe the installed CLI before each
batch:

```sh
codex --version
codex exec --help
```

The adapter targets the non-interactive **codex exec** command and SHOULD use,
when supported:

- stdin prompt input through **-**.
- **--json** for machine-readable events.
- **--ephemeral** to avoid persistent session state.
- **--ignore-user-config** for experimental isolation.
- **--ignore-rules** when participant rules are materialized explicitly.
- **--output-schema** for declared structured output.
- **--output-last-message** for final output capture.
- **--sandbox** with the frozen run profile.
- **-C** for the participant workspace.
- **--skip-git-repo-check** only when workspace initialization is disabled.

The adapter MUST NOT assume flags solely from the specification. It records the
probed version and help digest, verifies every required flag, and fails
preflight with **AGENT_CAPABILITY_UNSUPPORTED** if the installed CLI cannot
provide the selected treatment.

Mock and provider credentials MUST NOT be passed as CLI arguments. The
controller may require provider credentials, but participant-generated shell
commands receive a separately filtered environment. If the installed Codex
architecture cannot hard-separate provider connectivity from tool-executor
egress, the run isolation level is partial or advisory and the report says so.

The adapter records:

- Codex version.
- Exact secret-free argv.
- Model and effort.
- Sandbox mode.
- Feature probe.
- Exit code and signal.
- Normalized session events.
- Token and usage data when available.
- Final message and structured output parse status.

## 22. Runner lifecycle

### 22.1 Preflight

Before a trial:

1. Resolve effective config.
2. Refuse an existing batch ID.
3. Load and freeze the pack.
4. Compile OpenAPI and capability report.
5. Validate scenario completeness.
6. Compile prompts and participant file plan.
7. Compile the rubric and, only when an eval references a supported workflow
   feature, compile Arazzo. A referenced workflow on a build without that
   capability is an explicit preflight error.
8. Probe the adapter.
9. Validate exposure compatibility.
10. Calculate paid-call plan and resource ceilings.
11. Require confirmation when applicable.
12. Create the immutable batch skeleton.

No paid model call occurs before all batch-global checks succeed.

For StudyRun, all study-global work precedes child-batch creation and paid
calls:

1. Validate StudyProtocol, PhasePlan, and committed protocol lock.
2. Resolve the factor matrix and intended surface differences.
3. Materialize, compile, lint, and verify every ContractVariant.
4. Compile every ParticipantSurfaceManifest and cue audit.
5. Verify semantic mappings, behavior coverage, Eval/rubric compatibility,
   equivalence-review artifacts, and strict blinding policy.
6. Probe the adapter and resolve every runtime constant required by the
   PhasePlan.
7. Load the candidate primary/held-replacement schedule, deterministically
   recompute it from the locked seed and algorithm, and refuse any byte or
   semantic mismatch.
8. Calculate compatibility/cell keys, phase lock, paid-call maximum, and
   resource ceiling.
9. Refuse dirty analytical provenance, lock drift, count imbalance, missing
   seed, incompatible cell, or CLI disagreement.
10. Exclusively create the StudyRun and child-batch skeletons, then atomically
    freeze all locks, inputs, contracts, surfaces, and assignments.

Study preflight and **--dry-run** make no provider call and do not invoke a real
agent.

### 22.2 Trial setup

For each trial:

1. Resolve a standalone repetition or load one frozen StudyRun assignment plus
   its phase-lock run-ID/seed binding.
2. Exclusively create control, workspace, output, and evidence directories.
3. Atomically record lifecycle stage **scheduled**, linked to the already frozen
   batch/StudyRun assignment.
4. Create synthetic HOME and TMPDIR.
5. Create unique run credentials plus separate launcher and participant tool
   environments.
6. Create the per-run SQLite store.
7. Initialize behavior and state.
8. Start mock and optional documentation facade on loopback with port zero.
9. Wait for private readiness.
10. Materialize the exact ParticipantSurfaceManifest, including the sanitized
    contract for file visibility.
11. Configure per-run MCP when selected.
12. Hash and verify participant inputs and dynamic surface catalogs.
13. Atomically record **workspace_prepared** and **server_ready** as their facts
    become true.
14. Write **run.started.json**.
15. Invoke the adapter and record **participant_spawned** only after successful
    process/session creation.

The server starts before the participant, but the participant sees no readiness
or control endpoint.

### 22.3 Durable trial lifecycle

Every primary assignment has append-only assignment-level scheduling and
terminal facts. A trial-local **lifecycle.jsonl** begins only when setup creates
the exclusive trial directory; an activated held replacement receives one on
setup. A primary stopped before any trial-local setup has no fake trial
directory or lifecycle file: its **not_started** terminal fact lives in the
owning batch or StudyRun **assignment-events.jsonl**. Unused held slots remain
schedule metadata rather than fake trials. Each lifecycle record has schema
version, monotonically increasing lifecycle sequence, stage, RFC 3339 timestamp,
evidence source, and bounded details.

Stages are monotonic facts and cannot be cleared:

- **scheduled**
- **workspace_prepared**
- **server_ready**
- **participant_spawned**
- **model_started** when observable
- **participant_control_started**
- **api_started**
- **turn_completed**
- **report_present**
- **report_valid**
- **operator_signal_received**
- **finalization_started**
- **evidence_finalized**

Stage transitions MUST be flushed atomically before the runner takes the next
externally visible action. **operator_signal_received** is orthogonal and
records signal, timestamp, and which start boundaries had occurred.

The portable denominator boundary is **participant_control_started**: reliable
evidence shows the agent/model received control of the task. Adapters SHOULD
emit an explicit model/session start. Conservative fallbacks are:

- A participant-originated API or documentation request proves participant
  control started.
- A machine-readable model/session content event proves model and participant
  control started.
- A CLI usage, provider-authentication, configuration, or spawn failure before
  either form of evidence is pre-control.
- Ambiguous evidence is never classified in the participant's or system's favor;
  the reason and adapter limitation are reported.

**api_started** means the first participant-originated API exchange reached the
gateway. **turn_completed** means the adapter emitted its documented successful
terminal-turn event. Process exit zero, a report file, final prose, or cleanup
success alone does not imply turn completion.

The runner enforces wall-time, tool-call, request, token, disk, and process
limits independently; streams normalized session events; separates
controller/provider and participant tool environments; and handles
SIGINT/SIGTERM. It never retries participant behavior or failed API calls inside
one trial. A safe pre-control startup/provider retry MAY occur only when locked
policy allows it. After participant control, any retry is a new immutable trial
linked by **retry_of**.

A confirmed batch-wide launcher/configuration defect fails fast. Unlaunched
primary assignments become **not_started** and held replacements remain unused.
Agent task failure, malformed requests, invalid output, or rubric failure never
triggers fail-fast.

### 22.4 Terminal disposition and finalization

Every scheduled primary or activated replacement has exactly one terminal
disposition:

- **completed**
- **agent_incomplete**
- **agent_failed**
- **timed_out**
- **budget_exhausted**
- **operator_interrupted**
- **provider_failed_pre_control**
- **provider_failed_post_control**
- **infrastructure_failed_pre_control**
- **infrastructure_failed_post_control**
- **harness_aborted**
- **not_started**
- **invalid_setup**

Disposition derives from persisted facts in this precedence:

1. A persisted operator signal that occurs before timeout/budget firing becomes
   **operator_interrupted**.
2. A fired timeout becomes **timed_out**.
3. A fired execution budget becomes **budget_exhausted**.
4. A trial-local invalid input, materialization, or configuration discovered
   after scheduling but before participant spawn becomes **invalid_setup**.
5. Provider or infrastructure failure is classified pre/post control by
   **participant_control_started**.
6. A nonzero participant exit after control becomes **agent_failed**.
7. A persisted **turn_completed** becomes **completed**.
8. Participant exit without it becomes **agent_incomplete**.
9. A scheduled assignment for which no trial-local setup or participant launch
   began because the StudyRun stopped becomes **not_started**.
10. An active, unfinalized setup/execution ledger recovered after controller
    death becomes **harness_aborted**.

A valid report without **turn_completed** remains agent-incomplete. Graceful
cleanup exit zero cannot override interruption. Task result remains a separate
evaluator outcome.

Every terminal record also contains **evidence_integrity: intact | corrupt |
missing**, **censor_class: none | pre_control_nonparticipant |
administrative_censor | instrumentation_censor**, stable disposition/censor
reason codes, stage timestamps, process exit/signal, start-boundary evidence,
required artifact presence/hash results, and replacement/retry lineage. A
not-started primary stores the same terminal fields in its assignment event.
Integrity is evaluated against the frozen evidence-requirements manifest for the
selected Eval and, when applicable, every registered primary metric/estimand:
API/documentation/semantic streams, state, lifecycle, participant-surface
verification, result-status evidence, and declared artifacts. **intact** means
each required producer either emitted schema-valid hash-verified evidence or
recorded a valid observed absence allowed by its contract. **corrupt** means a
required artifact exists but fails parsing, hash, transaction, ordering, or
cross-stream consistency. **missing** means a required producer/artifact has no
valid record. Missing or malformed participant output is a captured task outcome
when the result-status record is intact and does not alone corrupt other
evidence.

Version 1 derives **censor_class** exactly once during finalization in this
precedence; an operator cannot choose or edit it:

1. If **participant_control_started** is absent, classify
   **pre_control_nonparticipant**. This covers not-started, invalid-setup,
   pre-control provider/infrastructure failure, pre-control interruption, and
   pre-control harness recovery.
2. Otherwise, **operator_interrupted** or **harness_aborted** classifies
   **administrative_censor**.
3. Otherwise, if any evidence dependency required by the frozen primary
   metric/estimand is corrupt, missing, or **unavailable_due_to_evidence**,
   classify **instrumentation_censor** and record the exact failed requirement
   IDs.
4. Otherwise classify **none**, including participant failure/timeout/budget
   outcomes and post-control provider/infrastructure failure from which the
   locked primary outcome remains deterministically evaluable on intact
   evidence.

These four rules are exhaustive. Disposition does not alone create an
instrumentation censor, and malformed requests, missing/malformed participant
prose, rubric failure, or an unfavorable outcome cannot become a censor when the
primary evidence contract remains satisfied. A PhasePlan eligibility selector
refers to this persisted field, never to an ad hoc analyzer interpretation.

Each metric additionally records **availability: observed | unknown |
not_applicable | unavailable_due_to_evidence** plus reasons. A missing optional
usage/report field can make that metric unknown without invalidating unrelated
primary evidence. A missing/corrupt primary dependency invokes the frozen
censor/replacement/worst-case policy and can never be converted to participant
failure merely to preserve a denominator.

Finalization:

1. Stop accepting participant activity.
2. Persist signal, timeout, budget, and finalization facts before termination.
3. Gracefully terminate the agent process group; force terminate after grace.
4. Verify descendants are gone.
5. Stop MCP, documentation facade, and mock.
6. Close SQLite and export API trace, documentation trace, semantic events, and
   final state.
7. Capture and validate participant output.
8. Verify participant inputs and complete participant surface.
9. Archive workspace without dereferencing symlinks.
10. Derive disposition, evidence integrity, censor class/reason, and per-metric
    availability.
11. Run deterministic evaluation when evidence permits.
12. Write the non-self-referential trial artifact manifest after every trial
    evidence payload.
13. Atomically write **run.completed.json** last with the trial-manifest digest.
14. Aggregate a child batch only when all its activated trials are terminal.
15. Finalize StudyRun only after schedule/replacement policy is resolved and all
    child batches are terminal or the StudyRun is atomically aborted.

A failed, interrupted, timed-out, zero-request, malformed-report, not-started,
or corrupt-evidence assignment remains represented. A recovered nonterminal
trial never resumes or relaunches; a new attempt requires a new trial.

### 22.5 Isolation levels

Every run records:

- **hard:** enforced filesystem and network isolation.
- **partial:** one major boundary is enforced while another is advisory.
- **advisory:** process configuration and instructions only.

Hosted execution MUST refuse advisory mode. Local execution MAY proceed after a
prominent warning. A local third-party agent CLI running as the same OS user may
inspect launcher-level host files; a fresh workspace and synthetic HOME do not
prevent that. For strong isolation and information blinding, recommend a
dedicated OS user, container, VM, or microVM with isolated provider credential
handling.

### 22.6 Information-blinding verification

The run separately records **blinding_mode: none | declared | strict**,
**participant_surface_template_sha256**,
**participant_surface_rendered_sha256**, cue-policy digest, cue-audit result,
pairwise surface-diff result for a StudyRun, and reviewer approvals. Strict
means the framework verified its declared surface; it does not claim the
participant process was unable to inspect the host. Hard isolation does not
imply a neutral prompt. Reports present both dimensions independently.

## 23. CLI contract

### 23.1 Source resolution

Commands accepting **source** accept:

- A local JSON, YAML, or YML OpenAPI document.
- A pack directory containing pack.yaml.

A bare OpenAPI document runs in contract mode. Scenario behavior, evals, custom
prompts, and rubrics require a pack. Remote document URLs are not accepted in
version 0.1.

Commands accepting **study-dir** accept a local directory containing
**study.yaml** plus referenced local protocol resources. They never treat an
OpenAPI document or pack as an implicit StudyProtocol. All study-owned
references use the same canonical-root, traversal, symlink, digest, size, and
duplicate-key protections as pack inputs.

A StudyProtocol's PackRef contains only Pack ID, version, and expected digest.
Commands that need Pack bytes resolve it from explicit **--pack <local-pack>**
or an installed local content-addressed catalog, then verify all three fields.
The Pack becomes a separate canonical root; a StudyProtocol cannot use **..**,
an absolute path, or a URI to choose it. No host path is part of study
compatibility identity or participant evidence.

### 23.2 Output rules

- Human progress and operational logs go to stderr.
- Machine-readable command output goes to stdout when **--format json** or
  **--json** is selected.
- A long-running server writes exactly one readiness JSON record to stdout, then
  no non-protocol stdout.
- Diagnostics include stable code, phase, source pointer where applicable, and
  remediation.
- Paths printed for local artifacts are absolute.
- Secrets are redacted before output.
- Commands support **--no-color** and respect NO_COLOR.

### 23.3 oal inspect

```sh
oal inspect <source> \
  [--format terminal|json] \
  [--out <path>] \
  [--strict] \
  [--operation <id-or-key>]
```

The report includes:

- OpenAPI version and source format.
- Source and semantic digests.
- Referenced document inventory.
- Operation count.
- Missing and duplicate operation IDs.
- Generated tool names and collisions.
- Supported, approximated, requires-scenario, and unsupported counts.
- Per-operation diagnostics.
- Unsupported schemas, serializers, media types, security flows, callbacks,
  webhooks, and links.
- Contract-mode viability.
- Direct-tool viability and schema size.
- Catalog-tool viability.
- Pack eval compatibility when source is a pack.
- Recommended exposure mode.

Strict mode returns unsupported-capability exit status if any affected operation
is not fully supported. Non-strict inspection succeeds while preserving
diagnostics.

### 23.4 oal serve

```sh
oal serve <source> \
  [--mode contract|scenario] \
  [--scenario <id>] \
  [--host <host>] \
  [--port <port>] \
  [--run-seed <value>] \
  [--run-id <id>] \
  [--run-dir <path>] \
  [--resume <unfinalized-run-dir>] \
  [--ready <path>] \
  [--credentials-out <path>] \
  [--strict] \
  [--allow-non-loopback]
```

Defaults:

- Host 127.0.0.1.
- Port 4010 for manual serve; zero requests an ephemeral port.
- Contract mode for a raw OpenAPI document.
- Pack default mode for a pack.
- Seed derived from contract, scenario, and run ID.
- A new run directory under .oal/runs.

The command refuses:

- An existing run directory unless it is the exact target of **--resume**.
- A stale readiness path.
- State whose run, contract, pack, scenario, backend, or seed digest differs.
- Non-loopback binding without explicit unsafe opt-in.
- Non-loopback binding in hosted mode.

**--resume** is mutually exclusive with **--run-id**, **--run-dir**, and
**--run-seed**. It is allowed only for an unfinalized manual run or a
runner-controlled mock restart whose private control directory and
data-encryption key still exist. Resume verifies run ID, contract
semantic/execution digests, source inventory, pack, scenario, ContractVariant,
backend bundle, implementation digest, state schema, seed, SQLite integrity, and
last committed API/semantic event before binding a new listener. It never
relaunches an agent. A finalized run is immutable and cannot resume; replay
creates a new control run instead.

Readiness record:

```json
{
  "schema_version": 1,
  "status": "ready",
  "mode": "contract",
  "baseUrl": "http://127.0.0.1:4010",
  "runId": "manual-01",
  "contractSha256": "SEMANTIC_DIGEST",
  "operationCount": 84,
  "supportedOperationCount": 82,
  "capabilitiesPath": "/absolute/path/to/capability-report.json",
  "credentialsPath": "/absolute/private/control/credentials.json"
}
```

For a secured manual mock, credentials are written to a private control file so
a human client can authenticate. The default path is inside the run’s
non-evidence control directory. **--credentials-out** selects another exact
path. The file:

- Is created exclusively with mode 0600.
- Is never placed in the participant bundle or finalized evidence.
- Is deleted when the manual server finalizes.
- Contains every supported OR alternative and all schemes required by each AND
  set.
- Uses deterministic environment aliases derived from the security-scheme name,
  with collision checks.
- Contains actual synthetic values and therefore is never printed, logged, or
  hashed into ordinary evidence.

Example shape:

```json
{
  "schema_version": 1,
  "run_id": "manual-01",
  "base_url": "http://127.0.0.1:4010",
  "alternatives": [
    {
      "index": 0,
      "schemes": [
        {
          "scheme": "steelApiKey",
          "type": "apiKey",
          "location": "header",
          "wire_name": "steel-api-key",
          "environment": "OAL_AUTH_STEELAPIKEY",
          "value": "SYNTHETIC_SECRET_VALUE"
        }
      ]
    }
  ]
}
```

Basic credentials use separate username and password fields/environment aliases;
Bearer/OAuth/OIDC use a token field. **oal run** does not expose this file to
the participant: it injects only pack-declared toolEnvironment variables or MCP
authentication.

### 23.5 oal pack init

```sh
oal pack init <directory> --openapi <path>
```

The command:

- Refuses a non-empty target.
- Copies, rather than modifies, the OpenAPI document.
- Creates a minimal versioned manifest.
- Creates behavior, fixtures, prompts, tasks, schemas, evals, workflows, and
  tests directories.
- Adds a contract-mode smoke task without inventing business assertions.
- Writes a README explaining contract versus scenario fidelity.

It never generates a claim that an operation mutates or persists data.

### 23.6 oal pack validate

```sh
oal pack validate <pack> [--strict] [--format terminal|json]
```

Validation includes:

- Manifest and path safety.
- OpenAPI compilation.
- Capability policy.
- Scenario backend API version.
- Exact or partial operation completeness.
- Fixture and initial-state parsing.
- Response conformance tests declared by the pack.
- Prompt variables and participant file plan.
- Result schemas.
- Rubric compilation.
- Arazzo mapping.
- Credential scheme mapping.
- Redaction configuration.
- Effective isolation warning.

### 23.7 oal eval init and validate

```sh
oal eval init <pack> --id <id>
oal eval validate <pack> [--eval <id>] [--strict]
```

Init creates a minimal task, result schema, and rubric template. It does not
infer API-specific success.

Validate renders a preview with synthetic non-secret variables, validates every
check, verifies task/scenario capability, and proves hidden assets are absent
from the participant plan.

### 23.8 oal run

```sh
oal run <pack> \
  --eval <id> \
  [--profile <path>] \
  [--scenario <id>] \
  [--agent <adapter>] \
  [--model <id>] \
  [--effort <level>] \
  [--exposure raw-http|direct-tools|catalog-tools] \
  [--contract-visibility file|discoverable|tool-only|none] \
  [--data-plane-scope all|eval] \
  [--count <n>] \
  [--parallel <n>] \
  [--batch <id>] \
  [--timeout <duration>] \
  [--cohort-seed <value>] \
  [--sandbox <mode>] \
  [--yes] \
  [--dry-run] \
  [--no-fail-on-eval]
```

**--dry-run** performs all preflight, renders a temporary participant preview,
probes the adapter, prints treatment variables, shows the paid-call and resource
plan, then exits without starting an agent or permanent batch.

Interactive paid runs require confirmation unless **--yes** is supplied. A
non-interactive environment without an explicit approval flag fails before a
paid call.

Existing batch IDs are always refused. There is no force-overwrite flag.

### 23.9 oal evaluate

```sh
oal evaluate <run-or-batch> [--rubric <path>] [--out <path>]
```

Evaluation verifies artifact hashes first. The default uses the frozen rubric.
Supplying a different rubric creates a derived evaluation artifact with a new ID
and never overwrites the original.

### 23.10 oal report

```sh
oal report <run-or-batch> \
  [--format terminal|json|markdown|html] \
  [--out <path>] \
  [--regrade]
```

JSON is canonical. Terminal, Markdown, and future HTML are projections.
**--regrade** creates a derived evaluation/report pair and records evaluator
version and rubric digest.

### 23.11 oal compare

```sh
oal compare <batch-a> <batch-b> \
  [--format terminal|json|markdown] \
  [--out <path>]
```

Comparison includes:

- Task and check pass rates.
- Every frozen denominator and its numerator, exclusions, and unknown counts.
- Infrastructure and provider outcomes.
- Operation usage.
- HTTP errors.
- Call/token/time/cost budgets.
- Ordered sequence variants.
- Wilson confidence intervals for binary rates.
- Paired differences only when an explicit design declares pairing and complete
  pair membership; aligned seeds alone are insufficient.
- Every experiment-cell difference.

This command is descriptive. It MUST not pool incompatible batches, claim
statistical significance from a single run or unplanned comparison, apply an
undeclared weighting, or select a winner. Registered inferential comparisons use
**oal study analyze**.

### 23.12 oal replay

```sh
oal replay <run> [--request <sequence>] [--verify]
```

Replay starts no agent. It reconstructs the mock from frozen inputs and recorded
request order. Verify mode checks deterministic status, contract-visible
headers/body, state digests, and normalized logical fields. Real timestamps and
latency are excluded.

Each request is classified **full**, **substitutable**, or **unavailable** for
replay. Declared authentication is substitutable: replay generates a fresh valid
credential mapped to the same redacted principal identity. A secret-bearing body
is unavailable unless the pack declares a deterministic non-secret substitution
that preserves the tested semantics. Replay reports verified-request count and
coverage and MUST NOT claim full verification when any required request is
unavailable.

### 23.13 oal doctor

```sh
oal doctor [--agent <adapter>] [--format terminal|json]
```

Doctor checks:

- Node and package versions.
- SQLite availability.
- Adapter executable and feature probe.
- Supported sandbox mechanisms.
- Loopback and ephemeral-port behavior.
- Process-group termination support.
- Network-isolation capability.
- File permission behavior.
- Optional container/runtime prerequisites.

It makes no paid model call.

### 23.14 oal study init, validate, and lock

```sh
oal study init <new-study-dir> \
  --pack <pack> \
  --eval <id> \
  --id <id>

oal study validate <study-dir> \
  [--pack <local-pack>] \
  [--phase <id>] \
  [--check-lock] \
  [--write-lock] \
  [--materialize-contracts <dir>] \
  [--format terminal|json]
```

**study init** refuses a non-empty target, validates the explicitly supplied
local Pack, records only its ID/version/digest PackRef, and creates a minimal
schema-valid StudyProtocol, participant-surface policy, non-analytical smoke
PhasePlan, analysis-plan placeholder, and authoring README. It does not persist
the host Pack path or invent factors, hypotheses, metrics, effect sizes, sample
sizes, equivalence claims, or confirmatory rules.

Validation resolves the identity-only PackRef against **--pack** or the local
content-addressed catalog, compiles StudyIR, factors, PhasePlans, variants,
participant surfaces, cue policy, rubrics, semantic schemas, analysis methods,
and equivalence-review requirements without launching an agent. A missing or
ID/version/digest-mismatched Pack fails closed. **--check-lock** is the normal
analytical path and fails on drift. **--write-lock** is an explicit maintainer
action, refuses a protocol version with existing paid analytical evidence, and
never runs automatically from preflight. Materialization writes only to a newly
created exact target and never overwrites the canonical contract.

### 23.15 oal study schedule

```sh
oal study schedule <study-dir> \
  --phase <id> \
  --seed <value> \
  --study-run <id> \
  [--out <new-assignments.json>] \
  [--format terminal|json]
```

The command checks the protocol lock, expands cells, verifies required
divisibility/balance, and emits byte-deterministic primary and held assignments
already bound to the requested StudyRun ID. Without **--out** it is a preview.
With **--out**, the target must not exist; the file remains a candidate until
**study run** verifies the same StudyRun ID and binds its digest into a phase
lock. It reports primary assignments, held capacity, maximum paid launches,
blocks, cell counts, and whether the phase is analytical. It launches no server,
adapter, or provider call.

### 23.16 oal study run

```sh
oal study run <study-dir> \
  --phase <id> \
  [--pack <local-pack>] \
  --schedule <assignments.json> \
  --study-run <id> \
  --model <id> \
  --effort <level> \
  [--agent <adapter>] \
  [--sandbox <mode>] \
  [--yes] \
  [--dry-run]
```

The command refuses CLI values that disagree with the PhasePlan or candidate
schedule. It probes the adapter, calculates compatibility keys, builds the phase
lock, prints exact paid-call maximum and every cell, then requires explicit paid
confirmation. **--dry-run** completes the same validation in a temporary root,
starts no real agent, persists no StudyRun, and makes no provider call. An
analytical phase refuses dirty provenance and an existing study-run ID; there is
no force or resume-into-same-trial flag.

### 23.17 oal study analyze

```sh
oal study analyze <study-run-dir> \
  [--format terminal|json|markdown] \
  [--out <path>] \
  [--analysis-plan <frozen-derived-plan>] \
  [--include-study-run <compatible-dir>]
```

The default analysis verifies protocol, phase, schedule, compatibility,
implementation, and evidence hashes, then executes exactly the frozen plan. A
derived plan or multi-StudyRun aggregation creates a new analysis lineage, must
explicitly authorize every compatible input, and cannot overwrite or masquerade
as the preregistered result. Cross-key aggregation is refused. Smoke/development
assignments appear only in operational diagnostics.

### 23.18 Stable exit codes

| Code | Meaning                                                                                                                  |
| ---: | ------------------------------------------------------------------------------------------------------------------------ |
|    0 | Command succeeded and requested evaluation threshold passed, or no threshold applied.                                    |
|    2 | Invalid CLI input, configuration, contract, pack, prompt, workflow, rubric, StudyProtocol, PhasePlan, lock, or schedule. |
|    3 | One or more provider or infrastructure failures.                                                                         |
|    4 | Requested capability unsupported.                                                                                        |
|    5 | Execution completed but fail-on evaluation threshold was not met.                                                        |
|  130 | Interrupted by SIGINT.                                                                                                   |
|  143 | Interrupted by SIGTERM.                                                                                                  |

Precedence is interruption, internal/invalid evidence as 3, invalid setup as 2
or 4, evaluation threshold as 5, success as 0. **--no-fail-on-eval** changes 5
to 0 but never changes persisted task outcomes.

## 24. Evidence store and artifact layout

### 24.1 Batch layout

The default artifact root is **.oal/runs**. The tree below starts at that root
and omits the leading .oal only for readability.

```text
runs/<batch-id>/
  batch.json
  assignment-events.jsonl
  inputs/
    pack.frozen.yaml
    contract.original
    contract.ir.json
    capability-report.json
    run-profile.frozen.yaml
    prompt.frozen.txt
    instructions.frozen.md
    task.frozen.md
    result-schema.frozen.json
    rubric.frozen.yaml
    evidence-requirements.json
    workflow.frozen.yaml
    participant-surface-template.json
  trials/
    <run-id>/
      run.started.json
      run.completed.json
      lifecycle.jsonl
      participant-surface-manifest.json
      participant-surface-verification.json
      server.json
      state.sqlite
      trace.jsonl
      documentation.jsonl
      semantic-events.redacted.jsonl
      state.final.json
      state.summary.json
      participant-final.txt
      participant-report.json
      evaluation.json
      resource-usage.json
      artifact-manifest.json
      session/
        events.redacted.jsonl
        stdout.redacted.log
        stderr.redacted.log
      workspace/
      blobs/
        sha256/
          <digest>
      operator/
        backend-errors.log
  cohort-evaluation.json
  report.json
  report.md
  artifact-manifest.json
  batch.completed.json
```

Raw unredacted artifacts are absent by default. Operator-only error logs are
still redacted for secrets and may contain internal stack traces only when
explicitly enabled.

### 24.2 StudyRun layout

Study evidence lives under **.oal/studies**:

```text
studies/<study-run-id>/
  study-run.json
  assignment-events.jsonl
  inputs/
    study-protocol.frozen.yaml
    phase-plan.frozen.yaml
    protocol.lock.json
    phase.lock.json
    assignments.json
    compatibility.json
    analysis-plan.frozen.json
    evidence-requirements.json
    source-provenance.json
    variants/
      variant-set.frozen.yaml
      <variant-id>.openapi.json
      <variant-id>.capability-report.json
      <variant-id>.diff.json
    participant-surfaces/
      <cell-id>.template.json
      <cell-id>.cue-audit.json
    reviews/
      equivalence-review.json
      blinding-review.json
  batches/
    <batch-id>/
      batch.json
      trials/
        <run-id>/
          ... ordinary trial artifacts ...
      cohort-evaluation.json
      artifact-manifest.json
      batch.completed.json
  analyses/
    preregistered/
      analysis.json
      report.json
      report.md
    derived/<analysis-id>/
  operational-diagnostics.json
  artifact-manifest.json
  study.completed.json
```

Each child batch conforms to the ordinary batch/trial schema and resolves
exactly one cell. The StudyRun manifest is the only owner of global assignment
order and replacement activation. Child batches cannot infer or change it.
StudyRun finalization writes its own non-self-referential manifest after every
referenced child manifest is final.

For an ordinary batch, its root **assignment-events.jsonl** owns
scheduling/terminal facts. For a StudyRun, the StudyRun-level file is the sole
assignment ledger and child batches omit the ordinary batch-level copy; child
reports reference global event IDs. There is never more than one mutable owner
for one assignment.

### 24.3 Artifact invariants

- Participant workspace and evidence are separate during execution.
- The workspace is outside the pack, source repository, evidence tree, and
  sibling workspaces.
- Only declared participant files are copied.
- **batch.json** and **run.started.json** are write-once.
- Study protocol, PhasePlan, locks, assignments, compatibility keys, participant
  surfaces, and **study-run.json** are write-once.
- The batch/cell surface template and each rendered trial surface
  manifest/verification are write-once; verification names every discovered
  entry and any mismatch rather than rewriting the manifest.
- Completion uses separate files.
- **trace.jsonl** is append-only.
- **lifecycle.jsonl**, **documentation.jsonl**, and
  **semantic-events.redacted.jsonl** are append-only.
- **assignment-events.jsonl** is append-only and is the only mutable record of
  held-slot activation and assignment launch/terminal transitions.
- SQLite remains private until shutdown; if retained, it is treated as sensitive
  evidence.
- Final state, report, evaluation, and resource usage are atomic writes.
- Mutable readiness and sockets live in a private control directory.
- The mock stops before workspace archive.
- Archive never dereferences participant-created symlinks.
- Failed and zero-request trials remain present.
- Not-started primaries remain assignment/terminal records; unused held
  replacements remain schedule entries and do not receive trial directories.
- The persisted **workspace/** is a sanitized snapshot, not a raw recursive
  copy. Declared text outputs are redacted, binary outputs become bounded
  retained blobs or metadata according to policy, symlinks are inert entries,
  and every archived item has original byte length and a safe digest policy. A
  raw workspace archive requires the separately encrypted research mode.
- Each scope's **artifact-manifest.json** is written after all evidence payloads
  in that scope and excludes itself and the later completion pointer. A trial
  manifest covers its trial payloads; a batch manifest covers batch-owned files
  plus every trial-manifest/completion-pointer digest; a StudyRun manifest
  covers study-owned files plus every child-batch manifest/completion-pointer
  digest. Parent manifests do not duplicate every descendant leaf entry.
- **run.completed.json** points to the finalized trial-manifest digest and is
  written after it.
- **batch.completed.json** points to the finalized manifest digest.
- **study.completed.json** points to the finalized StudyRun manifest digest.
- No artifact stores credentials, complete inherited environment values, or
  unnecessary host-home paths.

### 24.4 Artifact manifest

For every artifact:

```json
{
  "path": "trials/run-01/trace.jsonl",
  "bytes": 48102,
  "sha256": "DIGEST",
  "media_type": "application/x-ndjson",
  "producer": {
    "component": "@agentlab/evidence",
    "version": "0.1.0"
  },
  "sensitivity": "redacted"
}
```

Expected missing artifacts are recorded with reason in run completion or, for a
not-started assignment with no trial directory, its terminal assignment event;
they do not receive fabricated empty files.

Verification starts at the requested scope's completion pointer, verifies that
manifest, then recursively verifies every referenced child manifest and leaf. A
valid parent digest with an invalid descendant is invalid evidence.

### 24.5 Frozen implementation metadata

Batch/run artifacts record:

- Original and semantic contract digests.
- Resolved document inventory.
- Pack, fixture, scenario, behavior bundle, prompt, task, schema, workflow, and
  rubric digests.
- StudyProtocol, PhasePlan, protocol/phase lock, assignment schedule,
  factor/cell, ContractVariant, participant-surface, cue-policy,
  response-profile, semantic-registry, and analysis-plan digests when
  applicable.
- Core, compiler, gateway, documentation facade, backend, evaluator, statistics,
  report, scheduler, runner, and adapter versions.
- Agent CLI/SDK version and feature-probe digest.
- Model, effort, inference settings available to the adapter, and seed.
- Exposure, visibility, sandbox, isolation level, timeout, limits, count, and
  parallelism.
- Node version, OS, architecture, and package lock digest.
- Environment variable names supplied, never values.
- Per-trial assignment/replacement lineage, lifecycle stages and evidence
  sources, terminal disposition/reason, evidence-integrity result/reason, cell
  key, and StudyRun compatibility key.
- Content-addressed release provenance or clean-worktree commit/status;
  permitted non-analytical dirty runs additionally record relevant source
  inventory and diff digest.

## 25. Normalized trace

### 25.1 One exchange per request

Every request that reaches the data plane produces exactly one **api.exchange**
event, including:

- Unknown path.
- Wrong method.
- Authentication rejection.
- Malformed body.
- Validation failure.
- Limit failure.
- Injected fault.
- Behavior domain error.
- Behavior crash.
- Response validation failure.
- Backend timeout.
- Client disconnect.

Before documentation/product dispatch, the controller allocates one monotonic
**participant_ingress_sequence** for every participant-originated HTTP or MCP
ingress accepted far enough to identify its plane. API and documentation events
retain their plane-local sequence and also carry this shared sequence.
Allocation order is the controller's observed ingress order and is independent
of completion time, wall-clock timestamp resolution, or concurrent handler
completion. Control probes use actor **control** and a separate namespace.

### 25.2 Event example

```json
{
  "schema_version": 1,
  "type": "api.exchange",
  "event_id": "evt_00000001",
  "sequence": 1,
  "participant_ingress_sequence": 2,
  "observed_at": "2026-08-27T12:00:00.482Z",
  "logical_time": "2000-01-01T00:00:00.000Z",
  "batch_id": "codex-baseline-01",
  "run_id": "codex-baseline-01-run-01",
  "eval_id": "checkpoint-recovery",
  "actor": "participant",
  "transport": {
    "kind": "http",
    "request_id": "req_00000001",
    "connection_id": "conn_0001"
  },
  "operation": {
    "matched": true,
    "key": "path:POST /v1/computers",
    "uid": "op_78c844bd7fa4",
    "operation_id": "createComputer",
    "method": "POST",
    "path_template": "/v1/computers",
    "support": "supported"
  },
  "request": {
    "received_at": "2026-08-27T12:00:00.480Z",
    "method": "POST",
    "path": "/v1/computers",
    "query_string": "",
    "query": [],
    "path_parameters": {},
    "headers": [
      {
        "name": "content-type",
        "values": ["application/json"],
        "redacted": false
      },
      {
        "name": "steel-api-key",
        "values": ["[REDACTED]"],
        "redacted": true
      }
    ],
    "credential_present": true,
    "content_type": "application/json",
    "body": {
      "kind": "json",
      "size_bytes": 56,
      "value": {
        "template": "system/chrome",
        "env": {
          "EXPERIMENT_MODE": "1"
        }
      },
      "truncated": false
    }
  },
  "authentication": {
    "status": "authenticated",
    "alternative_index": 0,
    "schemes": ["steelApiKey"],
    "principal_ref": "principal_01"
  },
  "validation": {
    "request": {
      "status": "valid",
      "violations": []
    },
    "response": {
      "status": "valid",
      "violations": []
    }
  },
  "backend": {
    "mode": "scenario",
    "name": "steel-computer",
    "outcome": "handled",
    "duration_ms": 1,
    "response_provenance": "behavior",
    "effects": ["computer.created"],
    "observations": {
      "computer_id": "comp_0001"
    }
  },
  "response": {
    "completed_at": "2026-08-27T12:00:00.483Z",
    "status": 201,
    "headers": [
      {
        "name": "content-type",
        "values": ["application/json; charset=utf-8"],
        "redacted": false
      }
    ],
    "content_type": "application/json",
    "body": {
      "kind": "json",
      "size_bytes": 87,
      "value": {
        "id": "comp_0001",
        "state": "running",
        "template": "system/chrome"
      },
      "truncated": false
    }
  },
  "state": {
    "revision_before": 0,
    "revision_after": 1,
    "digest_before": "BEFORE_DIGEST",
    "digest_after": "AFTER_DIGEST",
    "projections": {
      "before": null,
      "after": {
        "computer": {
          "id": "comp_0001",
          "state": "running",
          "file_count": 0,
          "env_keys": ["EXPERIMENT_MODE"]
        }
      }
    }
  },
  "idempotency": {
    "status": "not_requested"
  },
  "replay": {
    "classification": "full",
    "reason_code": null
  },
  "error": null,
  "duration_ms": 3,
  "resource_usage": {
    "request_bytes": 180,
    "response_bytes": 144
  },
  "extensions": {}
}
```

### 25.3 Body variants

Exactly one variant applies:

```json
{ "kind": "none" }
```

```json
{
  "kind": "json",
  "size_bytes": 123,
  "value": {},
  "truncated": false
}
```

```json
{
  "kind": "text",
  "size_bytes": 123,
  "sha256": "DIGEST",
  "text": "bounded redacted preview",
  "truncated": false
}
```

```json
{
  "kind": "binary",
  "size_bytes": 123,
  "sha256": "DIGEST",
  "blob_ref": null
}
```

```json
{
  "kind": "multipart",
  "size_bytes": 456,
  "parts": [
    {
      "name": "file",
      "filename": "brief.txt",
      "headers": [],
      "body": {
        "kind": "binary",
        "size_bytes": 12,
        "sha256": "DIGEST",
        "blob_ref": null
      }
    }
  ]
}
```

When enabled, blob references are **blobs/sha256/<digest>**. Blob writes are
content-addressed and exclusive.

### 25.4 Trace invariants

- Sequence starts at one for each run and is allocated at ingress.
- JSONL exports are in sequence order. Concurrent completions buffer until prior
  records can be appended.
- Query parameters and headers remain ordered arrays.
- Header names are lowercase; values retain wire order.
- **path**, **query_string**, parsed query values, cookies, headers, and path
  parameters are redacted before event persistence. Sensitive path segments use
  a stable HMAC fingerprint when cross-event equality is required; the raw
  target is never retained.
- Unmatched paths have matched false and null operation identity fields.
- Wrong methods include candidate path templates and allowed methods under error
  details.
- Validation violations use JSON Pointers and stable codes.
- State revisions change only after a committed behavior transition.
- Monotonic duration is not derived from wall timestamps.
- Stack traces and raw internal exceptions are excluded.
- Export flushes each event. A truncated final JSONL line becomes an artifact
  error while prior complete events remain usable.
- HTTP, direct MCP, and catalog MCP share this schema.
- A raw-body digest is not retained when it could reveal equality of a
  registered secret. Binary digests are allowed only where byte equality is
  necessary for task evidence.
- **backend** is null for failures resolved before backend invocation.
- **response** is null when no response was produced, including an early client
  disconnect. The error layer and terminal transport outcome remain present.
- Request, response, validation, backend, and state fields use explicit nulls
  for inapplicable values; readers MUST NOT infer “success” from a missing
  field.
- Authentication records the matched alternative and a redacted stable principal
  reference, never credential material.
- Replay classification is full when persisted normalized data is sufficient,
  substitutable when a declared safe replacement preserves semantics, and
  unavailable otherwise.

### 25.5 Error shape

```json
{
  "layer": "validation",
  "code": "request_schema_invalid",
  "message": "Request body failed schema validation.",
  "retryable": false,
  "details": {
    "violations": [
      {
        "location": "body",
        "pointer": "/template",
        "code": "required",
        "message": "Required property is missing."
      }
    ]
  }
}
```

Layer is routing, authentication, parsing, validation, behavior, timeout,
transport, persistence, or internal.

### 25.6 Documentation exchange stream

Every request matching the frozen documentation-candidate inventory produces
exactly one **documentation.exchange** in **documentation.jsonl**, whether the
selected visibility serves a contract, returns an index, rejects authentication,
or returns the paired neutral 404.

```json
{
  "schema_version": 1,
  "type": "documentation.exchange",
  "event_id": "doc_00000001",
  "sequence": 1,
  "participant_ingress_sequence": 1,
  "observed_at": "2026-08-27T12:00:00.400Z",
  "batch_id": "api-shape-pilot-cell-01",
  "run_id": "api-shape-pilot-cell-01-run-01",
  "actor": "participant",
  "request": {
    "method": "GET",
    "path": "/openapi.json"
  },
  "candidate": {
    "profile": "openapi-conventional-v1",
    "route_id": "openapi-json"
  },
  "authentication": {
    "status": "authenticated"
  },
  "visibility": "discoverable",
  "outcome": "contract_served",
  "response": {
    "status": 200,
    "content_type": "application/json",
    "bytes": 48102,
    "body_sha256": "PARTICIPANT_CONTRACT_DIGEST"
  },
  "duration_ms": 1,
  "extensions": {}
}
```

The record contains no contract body, credential, protocol/factor label, or
private path. **sequence** is independent and monotonic within the documentation
stream; **participant_ingress_sequence** gives deterministic chronology against
participant API ingress without merging or renumbering either plane-local
stream. Timestamps remain observational. Reports distinguish the first
documentation probe, first successful discovery, and whether API probes occurred
before or after discovery. Documentation exchanges never increment product
request or operation counts.

### 25.7 Semantic event stream

Scenario packs MAY emit first-class committed domain facts. They complement
**api.exchange** and final state; they never replace observable request
evidence. Events are transactionally stored and exported to
**semantic-events.redacted.jsonl**:

```json
{
  "schema_version": 1,
  "type": "semantic.event",
  "event_id": "sem_00000004",
  "semantic_sequence": 4,
  "run_id": "api-shape-pilot-cell-01-run-01",
  "pack_id": "workspace-service",
  "name": "workspace.created_from_saved_state",
  "event_version": 1,
  "logical_time": "2000-01-01T00:00:00.004Z",
  "caused_by_api_event_id": "evt_00000007",
  "actor": "participant",
  "state_revision_before": 5,
  "state_revision_after": 6,
  "payload_schema": "workspace.created_from_saved_state@1",
  "payload": {
    "source_ref": "saved_0001",
    "result_ref": "workspace_0002"
  }
}
```

Requirements:

- The Pack owns namespaced event names, integer versions, and Draft 2020-12
  payload schemas.
- Names describe committed facts and remain independent of HTTP path,
  operationId, tool name, and transport.
- State, visible response outcome, idempotency record, semantic events, and
  parent exchange commit or roll back atomically.
- Rolled-back, timed-out, response-invalid, or crashed behavior emits no
  committed semantic event.
- Idempotent replay references the original exchange/facts and emits no
  duplicate fact.
- Semantic sequence is monotonic per run; logical time and normalized payload
  are deterministic.
- Payloads validate and redact before commit and contain no credential,
  arbitrary backend object, stack, or executable value.
- Events are evaluator-visible and participant-hidden unless the OpenAPI
  contract independently exposes equivalent response data.
- **backend.effects** may mirror a bounded list of event names for trace
  convenience; this stream is authoritative.
- Same seed and API request sequence produce byte-identical normalized semantic
  events across HTTP/direct/catalog transports.
- A semantic event can prove a domain outcome. It cannot prove which
  documentation the participant saw, what it understood, or how it constructed a
  request.
- A state/event/parent-exchange contradiction is invalid evidence, never a
  participant failure.

## 26. Evaluator and rubric DSL

### 26.1 Principles

- Rubrics are hidden by default.
- Default evaluation is declarative.
- Arbitrary JavaScript is forbidden in the default evaluator.
- Expressions use a pinned CEL implementation or equivalent restricted engine.
- Time, random, filesystem, network, environment, reflection, process, and
  dynamic code functions are disabled.
- Every check returns evidence, not only a boolean.
- Evaluator errors are infrastructure outcomes, not task failures.

### 26.2 Evaluator inputs

- **events:** normalized API exchanges in ingress order.
- **documentation_events:** normalized documentation exchanges in
  documentation-sequence order.
- **semantic_events:** validated redacted semantic events in semantic-sequence
  order.
- **state:** final backend JSON state.
- **report:** parsed **participant-report.json** or null.
- **run:** frozen run metadata.
- **artifacts:** bounded presence, size, media type, and digest metadata.

Within a sequence:

- **event:** candidate event.
- **vars:** immutable captured values.
- **steps:** already selected step evidence.

### 26.3 Rubric example

```yaml
rubric_version: 1
id: steel-recovery
description: Prepare, checkpoint, alter, restore, and pause one Chrome computer

scoring:
  method: weighted_binary
  pass_threshold: 0.90

checks:
  - id: recovery_flow
    description: The same computer returns to the verified clean bytes
    kind: sequence
    weight: 8
    required: true
    match: any
    max_candidates: 10000
    steps:
      - id: create
        where: >-
          event.operation.operation_id == "createComputer" &&
          event.response.status >= 200 && event.response.status < 300 &&
          event.response.body.kind == "json" &&
          event.response.body.value.template == "system/chrome"
        capture:
          computer_id: event.response.body.value.id

      - id: initial_write
        where: >-
          event.operation.operation_id == "uploadFile" &&
          event.request.path_parameters.computer_id == vars.computer_id &&
          event.request.body.kind == "binary"
        capture:
          clean_sha: event.request.body.sha256

      - id: initial_read
        where: >-
          event.operation.operation_id == "downloadFile" &&
          event.request.path_parameters.computer_id == vars.computer_id &&
          event.response.status >= 200 && event.response.status < 300 &&
          event.response.body.kind == "binary" && event.response.body.sha256 ==
          vars.clean_sha

      - id: checkpoint
        where: >-
          event.operation.operation_id == "createCheckpoint" &&
          event.response.status >= 200 && event.response.status < 300 &&
          event.response.body.value.computer_id == vars.computer_id
        capture:
          checkpoint_id: event.response.body.value.id

      - id: changed_write
        where: >-
          event.operation.operation_id == "uploadFile" &&
          event.request.path_parameters.computer_id == vars.computer_id &&
          event.request.body.kind == "binary" && event.request.body.sha256 !=
          vars.clean_sha

      - id: restore
        where: >-
          event.operation.operation_id == "restoreComputer" &&
          event.request.body.kind == "json" &&
          event.request.body.value.checkpoint_id == vars.checkpoint_id &&
          event.response.body.value.id == vars.computer_id &&
          event.response.status >= 200 && event.response.status < 300

      - id: recovered_read
        where: >-
          event.operation.operation_id == "downloadFile" &&
          event.request.path_parameters.computer_id == vars.computer_id &&
          event.response.body.kind == "binary" && event.response.body.sha256 ==
          vars.clean_sha && event.response.status >= 200 &&
          event.response.status < 300

      - id: pause
        where: >-
          event.operation.operation_id == "pauseComputer" &&
          event.request.path_parameters.computer_id == vars.computer_id &&
          event.response.status >= 200 && event.response.status < 300

    postconditions:
      - id: final_paused
        expression: >-
          state.computers[vars.computer_id].state == "paused"

  - id: result_report
    description: Participant returned the required structured report
    kind: json_schema
    weight: 1
    required: true
    value: report
    schema: ../../schemas/checkpoint-recovery-result.schema.json

  - id: no_false_fanout
    kind: predicate
    weight: 1
    required: true
    expression: >-
      events.filter(e,
        e.operation.operation_id == "createComputer" &&
        e.response.status >= 200 &&
        e.response.status < 300
      ).size() == 1 && report.fan_out.supported == false

signals:
  - id: missing_or_bad_auth
    kind: predicate
    expression: events.exists(e, e.response.status == 401)

  - id: unknown_endpoint
    kind: predicate
    expression: >-
      events.exists(e,
        !e.operation.matched && e.response.status == 404
      )

  - id: invalid_transition
    kind: predicate
    expression: >-
      events.exists(e,
        e.error != null && e.error.code == "invalid_state"
      )

  - id: manual_resume
    kind: predicate
    expression: >-
      events.exists(e,
        e.operation.operation_id == "resumeComputer"
      )
```

### 26.4 Check kinds

Version 1 supports:

- **predicate:** one boolean expression.
- **event:** existential, universal, or counted event matching.
- **sequence:** ordered event matching with immutable captures and
  postconditions.
- **json_schema:** Draft 2020-12 validation.
- **artifact:** presence, digest, media type, or size assertion.
- **documentation_event:** existential, universal, counted, or ordered matching
  over documentation exchanges.
- **semantic_event:** existential, universal, counted, or ordered matching over
  committed semantic facts.

Convenience built-ins MAY compile into these primitives:

- Required operation.
- Forbidden operation.
- Unknown operation count.
- Status count.
- Call budget.
- Duration budget.
- Result-schema validity.
- Arazzo trace.
- Documentation discovery timing relative to API events.
- Semantic fact/sequence checks.

### 26.5 Scoring

- Check and signal IDs are unique safe IDs.
- Weights are finite nonnegative numbers.
- At least one check has positive weight.
- A binary pass contributes full weight; fail contributes zero.
- Score equals passed weight divided by total weight.
- A run passes only when score meets threshold and every required check passes.
- Signals never affect score.
- A missing or malformed participant report is an ordinary failed report check,
  not infrastructure failure.
- Every check declares evidence class **participant_observable**,
  **private_domain**, or **mixed**. Semantic facts alone cannot assert
  participant knowledge, documentation discovery, or request strategy.

### 26.6 Sequence semantics

- Steps are strictly ordered by event sequence.
- **match: any** searches with backtracking for a complete match.
- The selected complete match is the lexicographically smallest event-sequence
  tuple.
- Greedily committing to an incidental early event is incorrect.
- **max_candidates** bounds search. Exceeding it yields check status error.
- Captured variables are immutable.
- Re-capturing a name is a compile error.
- Capture runs only after the step predicate succeeds.
- Postconditions use captures from the selected complete sequence.

### 26.7 Expression failures

Predicates MUST return boolean. A missing property, type error, resource limit,
or forbidden function yields check status error. Optional **on_missing** is
fail, skip, or error; default is fail.

Rubric compilation resolves schemas, rejects traversal, bounds expression size
and cost, and type-checks where possible before the agent starts.

Semantic and documentation sequences use the same immutable captures,
backtracking, lexicographic tie-breaking, and candidate ceilings as API
sequences. Cross-stream participant API/documentation chronology compares
**participant_ingress_sequence**, never unrelated plane-local sequence values or
timestamps. Semantic causality uses **caused_by_api_event_id** and parent IDs
rather than reception order. If a legacy artifact lacks required shared-order
evidence, the chronology result is **indeterminate**, never guessed from tied
timestamps.

### 26.8 Evaluation evidence

Each check records:

- Status: passed, failed, error, or skipped.
- Weight and required flag.
- Selected event IDs.
- Captured redacted values.
- Failed expression or schema pointers.
- Artifact references.
- Human-readable explanation.

Example:

```json
{
  "schema_version": 1,
  "rubric_id": "steel-recovery",
  "run_id": "codex-baseline-01-run-01",
  "status": "passed",
  "score": 1,
  "passed_weight": 10,
  "total_weight": 10,
  "checks": [
    {
      "id": "recovery_flow",
      "status": "passed",
      "weight": 8,
      "required": true,
      "event_ids": ["evt_00000001", "evt_00000003", "evt_00000004"],
      "captures": {
        "computer_id": "comp_0001",
        "checkpoint_id": "chk_0002",
        "clean_sha": "DIGEST"
      },
      "message": "All ordered recovery steps and final-state conditions passed."
    }
  ],
  "signals": {
    "missing_or_bad_auth": false,
    "unknown_endpoint": false,
    "invalid_transition": false,
    "manual_resume": false
  },
  "infrastructure_errors": []
}
```

### 26.9 Model judge

A model judge is optional and secondary. It:

- Receives only redacted evidence.
- Has no tools, network, or filesystem.
- Records model, provider, inference settings, prompt digest, input digests, raw
  result, normalized result, token use, and cost.
- Cannot override a deterministic required-check failure.
- Is never the only evidence for an observable HTTP or state invariant.

### 26.10 Trusted custom evaluator extension

The safe default never loads executable oracle code. A future custom evaluator
extension is permitted only under an explicitly selected
**trusted-local-evaluator** or **isolated-evaluator** profile. It receives
frozen redacted artifacts through a versioned bounded IPC contract, has no
credentials, and is part of protocol, cell, compatibility, implementation, and
analysis identity. Hosted analytical execution requires isolation. Changing its
bytes after evidence collection creates a derived analysis and, for new trials,
a new protocol version. It cannot silently replace the frozen declarative
result.

## 27. Trial eligibility, compatibility, and reporting

### 27.1 Independent outcome axes

Every activated trial records independently:

- **terminal_disposition:** one value from section 22.4.
- **evidence_integrity:** intact, corrupt, or missing.
- **task_outcome:** passed, failed, partial, indeterminate, or not_evaluated.
- **participant_report_status:** absent, malformed, schema_invalid, valid, or
  unavailable_due_to_infrastructure.

They MUST never collapse into one ambiguous success boolean. A completed turn
may fail the task; an agent failure may leave intact state evidence; valid prose
cannot repair missing trace/state; and invalid output is normally task evidence
rather than infrastructure failure.

Evidence integrity is computed from the frozen evidence-requirements manifest,
while availability is also reported per metric. A valid empty stream or observed
absent participant report is different from a missing producer/file.

### 27.2 Preregistered replacement policy

A PhasePlan MAY freeze cell-matched held replacements. Every held slot has
assignment ID, cell, reserve index, eligible-stratum policy, treatment-template
digests, and capacity before the first primary launch. It receives the failed
primary's block/repetition as an immutable activation-event mapping, not as
mutable schedule state.

| Situation                                                                                | Main analytical treatment                                                                 | Replacement                                  |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------- |
| Completed or participant failure/timeout/budget exhaustion with intact required evidence | Include; deterministic outcome decides success and unsuccessful outcomes count as failure | Forbidden                                    |
| Isolated pre-control infrastructure/provider failure after common smoke passes           | Exclude from agent denominator; retain in operational yield                               | Activate frozen same-cell slot when declared |
| Operator interruption before control                                                     | Abort StudyRun; not an agent outcome                                                      | Forbidden                                    |
| Operator interruption after control                                                      | Administrative censor; include as failure in worst-case sensitivity                       | Forbidden and abort StudyRun                 |
| Post-control infrastructure failure with corrupt/missing required evidence               | Instrumentation censor; worst-case failure                                                | Activate frozen same-cell slot when declared |
| Post-control harness error with intact evidence and known turn outcome                   | Include; pass only if the turn completed and rubric passes                                | Forbidden                                    |
| Completed turn/report with corrupt or missing required evidence                          | Instrumentation censor; worst-case failure                                                | Activate frozen same-cell slot when declared |
| Recovered nonterminal controller state                                                   | Harness-aborted; abort immutable StudyRun                                                 | Forbidden; start a new StudyRun              |
| Not started after fail-fast/abort                                                        | Exclude from agent denominator; retain in operational yield                               | No automatic launch                          |

Replacement never applies to agent/task failure, malformed requests/report,
timeout, budget exhaustion, or an observed bad outcome. It uses the same cell
and StudyRun compatibility key, receives a new run/seed, and preserves the
original trial. At most the locked capacity may activate. A second eligible
failure beyond capacity makes the phase incomplete. Unused held slots are
**held_unused**, not trials or denominator members.

Every primary assignment defines exactly one registered **analysis slot**. The
main slot outcome is resolved in order: use the original primary when eligible;
otherwise use its one mapped eligible replacement; otherwise leave the slot
unresolved under the locked incomplete-phase rule. A replacement is a substitute
observation for that slot, never an additional primary unit. All original and
replacement attempts remain in operational tables and provenance.

The required participant-control-started worst-case sensitivity also has exactly
one value per primary analysis slot. It evaluates the slot's ordered attempt
chain: original first, then its mapped replacement if activated. If any attempt
in that chain started participant control and became **administrative_censor**
or **instrumentation_censor** before the slot obtained an eligible outcome, the
sensitivity assigns exactly one failure to the slot and ignores any later
replacement outcome for that sensitivity only. Thus a censored original plus an
eligible replacement is one worst-case failure, and a pre-control original plus
a censored replacement is also one worst-case failure. It MUST NOT count two
attempts from the same slot. A chain containing only pre-control nonparticipant
attempts does not become a failure; an eligible replacement, when present
without an earlier control-started censor, supplies that slot. Attempt-level
analyses may show every launch only as explicitly preregistered secondary
estimands and can never be mislabeled as the blocked primary estimand.

### 27.3 Required denominators

Every cohort reports raw counts for:

- **primary_assignment_count:** all frozen primary assignments.
- **activated_replacement_count:** held replacement slots whose frozen
  activation rule fired.
- **operational_assignment_count:** every primary assignment plus every
  activated replacement, whether or not a later fail-fast left it unlaunched.
- **launched_trial_count:** primary or replacement assignments that reached
  participant process/session creation.
- **not_started_count:** primaries that never launched.
- **participant_control_started_count:** trials with durable control-start
  evidence.
- **primary_agent_outcome_count:** resolved primary analysis slots whose
  contributing original or mapped replacement started participant control and is
  not an administrative/instrumentation censor.
- **api_behavior_count:** control-started trials with an intact API trace.
- **task_evaluation_count:** trials with sufficient evidence for the rubric.
- **report_agreement_count:** trials reaching turn_completed.
- **usage_observed_count:** trials whose adapter reported usage.
- **valid_evaluation_count:** trials with a deterministic evaluator outcome.

The legacy-friendly **intent_to_run** view uses all primary assignments. The
**valid_execution** view excludes verified pre-control
setup/provider/infrastructure failures and invalid evidence, but it is never
presented as a substitute for the locked primary estimand.

Agent-incomplete, agent-failed, timed-out, budget-exhausted, zero-request,
missing-report, and malformed-report attempts supply their primary slot when
control started and required evidence is intact; unsuccessful outcomes count as
failures. Whenever any attempt in a primary slot's chain is censored after
participant control, the report additionally calculates the preregistered
slot-preserving worst-case sensitivity defined in section 27.2. Reports
separately expose attempt counts, slot counts, substitution mappings, unresolved
slots, and the outcome source for every resolved slot.

Usage statistics include only observed values and always report missing count.
Missing token/cost/usage is unknown, never zero. Report-validity/agreement rates
use trials reaching **turn_completed** while still listing every
missing/malformed output.

### 27.4 Required report content

Reports include:

- Primary, activated-replacement, operational-assignment, launched-trial,
  held-unused, not-started, lifecycle-stage, disposition, evidence-integrity,
  censor, replacement, and task-outcome counts.
- Every metric/check numerator and denominator, with per-run evidence links.
- Per-metric availability/unknown/not-applicable counts and evidence-dependency
  reasons.
- Main and required worst-case sensitivity estimates.
- API and documentation request totals, status distributions, first
  discovery/probe chronology, operation frequency, semantic facts, and ordered
  sequence variants.
- Unknown endpoints, wrong methods, malformed requests, authentication failures,
  invalid transitions, retries, correction loops, and recovery after errors.
- Final-state summaries and participant-report parse/schema/agreement status.
- Token, duration, tool-call, request, and provider-cost distributions only when
  available.
- Exact cells, intended factors, compatibility keys, frozen input/implementation
  digests, schedule/block summaries, and replacement lineage.
- Trace truncation, missing/corrupt evidence, approximation, sandbox/isolation,
  blinding/cue-review, mock-fidelity, and unplanned-analysis warnings.

Reports MUST NOT translate missing evidence into “no issue observed,” pool smoke
with analytical data, trust participant-reported resource IDs over trace/state,
or expose hidden chain-of-thought.

### 27.5 Study and cell compatibility keys

Before any registered aggregation, the report builder calculates:

**study_compatibility_sha256** over canonical JSON containing values intended to
remain constant across the compared cells:

For every factor-bound field, the study key contains the ordered factor/level
binding manifest rather than one cell's selected value; the cell key adds that
selected effective value and digest. For every unbound field, the study key
contains the single effective value. This rule prevents an intended model,
exposure, scenario, or contract factor from looking like drift without allowing
an undeclared difference through.

- Protocol lock and PhasePlan digests.
- Pack, scenario, fixture, behavior, task, prompt, result-schema, workflow,
  rubric, semantic-registry, metric, evidence-requirements, missingness,
  response-profile, and cue-policy digests.
- Treatment-common model, effort, inference settings, adapter/agent versions,
  Node/platform, sandbox/isolation, timeout, limits, and parallel policy, or
  their ordered factor-binding manifests when intentionally varied.
- Compiler, gateway, documentation facade, mock adapter, behavior runtime, state
  store, redactor, evidence writer, evaluator, statistics, scheduler, runner,
  report builder, and dependency-lock digests.
- Common base-contract/projection digest and ordered complete inventory of
  variant manifests/effective-contract digests.
- Declared factor schema, selected cell inventory, eligibility, replacement,
  stopping, and analysis-plan digests.

**cell_compatibility_sha256** adds the cell's factor levels, effective
RunProfile, contract execution digest, scenario digest, and pre-localization
ParticipantSurfaceManifest digest.

Ephemeral run/study IDs, timestamps, random ports, generated credential values,
actual schedule seed/order, and individual run seeds are validated and reported
but excluded from the compatibility key. Their exclusion never causes automatic
pooling: combining separately balanced StudyRuns requires an explicit frozen
multi-study analysis lineage.

The registered analyzer refuses pooled treatment estimates, p-values, adjusted
families, or winner claims across different study compatibility keys, undeclared
cell drift, incomplete required blocks, mixed analytical status, or an
unbalanced confirmatory cohort. Ordinary **oal compare** may render incompatible
results side by side with every difference, but never combines their numerators.

### 27.6 Preregistered study analysis and statistics

Before analytical paid data, the PhasePlan freezes:

- Primary/secondary metrics and exact populations/denominators.
- Planned contrasts, primary deployment/exposure condition, direction when
  applicable, and comparison families.
- Eligibility, censoring, replacement, stopping, and worst-case sensitivity
  rules.
- Alpha, multiplicity method, interval/test methods, cell/stratum weighting, and
  floor/ceiling gates.
- Minimum important effect and power/sample-size rationale for confirmatory
  work.
- Maximum permitted claim and small-sample interpretation label.

Built-in deterministic methods include:

- Raw numerator/denominator and Wilson interval for a binary cell rate.
- Risk difference and Newcombe interval for two independent binary cells.
- Two-sided Fisher exact test.
- Holm step-down familywise adjustment over a declared comparison family.
- Explicitly paired difference only when the assignment unit and complete
  pairs/blocks are preregistered; matching run seeds alone do not establish
  pairing.
- Median, p25, p75, and range for duration/tokens; p95 only when sample size
  makes it meaningful.

Cross-factor marginals require a frozen weighting rule. Equal weighting across
arbitrary exposure cells cannot select a winner unless it is the declared
deployment estimand. Floor/ceiling in one exposure is a limit of that
condition's discrimination, not automatic evidence of API-shape equivalence.
Interaction analysis is descriptive unless separately hypothesized and powered.
Small pilots are labeled directional and cannot silently become confirmatory.

A single run and every unplanned contrast are descriptive. Parallel execution
remains a recorded treatment, not a transparent optimization. Statistics
implementations are pure, versioned, numerically tested against independent
reference vectors, and part of compatibility identity.

### 27.7 Immutable re-analysis

Analysis verifies protocol, phase, schedule, compatibility, implementation,
input, and evidence hashes. Rendering leaves canonical analysis JSON unchanged.
A changed rubric, metric, codebook, evaluator, statistics implementation,
weighting, eligibility rule, or analysis plan creates a derived analysis ID with
explicit lineage and never overwrites the preregistered result. Original trace,
state, semantic events, participant report, evaluation, and locks are never
edited.

## 28. Security and trust model

### 28.1 Security posture

OpenAPI, imported packs, prompts, agent/model output, and agent-generated
requests are potentially untrusted. The default system must prevent them from:

- Executing commands on the host through mock semantics.
- Reading or writing arbitrary host paths.
- Contacting a production API or arbitrary destination.
- Resolving unapproved references.
- Accessing provider or ambient credentials.
- Accessing another run’s state, trace, prompts, or artifacts.
- Causing unbounded CPU, memory, disk, process, request, or model-token use.
- Placing secrets in exported evidence.

“Safe” means defense in depth. Prompt instructions, environment filtering, and a
synthetic HOME are controls, but not a security boundary against a malicious
agent CLI running as the same OS user.

### 28.2 Assets to protect

1. Host filesystem and processes.
2. Provider credentials and user authentication state.
3. Cloud, SSH, browser, cookie, proxy, and package-registry credentials.
4. Other projects, repositories, workspaces, and runs.
5. Production services named in the input contract.
6. Mock state and scenario fixtures.
7. Hidden prompts, workflows, rubrics, and expected outcomes.
8. Traces, participant transcripts, and reports.
9. Evidence integrity and reproducibility.
10. Compute, storage, request, token, and provider-cost budgets.
11. Hosted tenants from one another.
12. The host of executable behavior extensions.

### 28.3 Trust classification

| Input or component                                   | Default trust                    | Required treatment                                                                      |
| ---------------------------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------- |
| OpenAPI JSON/YAML                                    | Untrusted                        | Bounded safe parse; no execution; no remote refs by default.                            |
| Descriptions, examples, defaults, links              | Untrusted data                   | Preserve as data; never treat as operator instructions.                                 |
| Imported prompt/task templates                       | Untrusted pack data              | Strict non-executable renderer and variable allowlist.                                  |
| Agent/model output                                   | Untrusted                        | Validate, limit, redact, sandbox, and never interpolate into shell.                     |
| Agent HTTP/tool requests                             | Untrusted                        | Validate, quota, transact, and redact.                                                  |
| Declarative scenario/rubric                          | Untrusted data                   | Versioned schema and bounded expression engine.                                         |
| StudyProtocol, PhasePlan, contract patch, cue policy | Untrusted research configuration | Versioned schemas, safe paths, non-executable transforms, locks, and bounded expansion. |
| JavaScript/native behavior                           | Executable and unsafe            | Trusted local or isolated extension runtime only.                                       |
| Custom evaluator extension                           | Executable and unsafe            | Explicit evaluator trust profile, bounded redacted IPC, and compatibility identity.     |
| Controller/orchestrator                              | Trusted computing base           | Holds lifecycle and provider access.                                                    |
| Gateway/state store                                  | Trusted computing base           | Scoped to one run.                                                                      |
| Agent CLI                                            | Semi-trusted dependency          | Isolate because it may inspect files or spawn descendants.                              |
| Model provider                                       | External processor               | Receives intended prompt/context only.                                                  |
| Artifact store                                       | Sensitive                        | Per-run access, retention, and integrity.                                               |

### 28.4 Trust boundaries

- **TB-1, operator to ingestion:** validate format, path, size, references,
  configuration, and limits.
- **TB-2, ingestion to ContractIR:** only normalized data and explicit
  capability outcomes cross.
- **TB-3, controller to participant:** only sanitized contract, instructions,
  task, result schema, and declared fixtures cross.
- **TB-4, agent driver to tool executor:** the driver may require provider
  network; model-generated commands receive a separate environment and network
  policy.
- **TB-5, participant to surfaces:** contract-derived HTTP/MCP product
  operations plus an optional protocol-declared documentation facade; no reset,
  state, grader, health, or admin endpoint.
- **TB-6, gateway to behavior runtime:** narrow validated request/response and
  scoped state protocol.
- **TB-7, runtime to artifacts:** scoped writer; participant cannot mount
  evidence.
- **TB-8, run to host or tenant:** OS account, container, VM, microVM, or
  explicit advisory local boundary.

### 28.5 Threats and mitigations

| Threat                                                         | Required mitigation                                                                                                                             |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Prompt injection in OpenAPI text                               | Delimit as untrusted data; keep system policy outside interpolation; enforce controls independently of prompts.                                 |
| Reference SSRF or file read                                    | Same-pack relative refs only; canonical root; traversal/symlink rejection; URL/file/data/custom schemes denied.                                 |
| Callback, link, webhook, example, or URL upload causes traffic | Never fetch or invoke in contract mode; synthetic scenario behavior only unless a future isolated fixture is explicit.                          |
| Agent calls source production server                           | Rewrite every effective server; enforce egress denial.                                                                                          |
| exec/shell/SSH/browser operation reaches host                  | Treat names and payloads as data; deterministic stand-in only.                                                                                  |
| Virtual file path escapes                                      | Use a virtual object store; never concatenate request paths with a host root.                                                                   |
| Behavior module compromises controller                         | Separate process/runtime, minimal environment, no controller import, kill with run.                                                             |
| Participant reads rubric/state/sibling evidence                | Fresh external workspace; no evidence mount; read-only declared inputs.                                                                         |
| Agent inherits provider/cloud credentials                      | Deny-by-default tool environment; credential broker/controller separation.                                                                      |
| Descendant survives run                                        | Process group/session termination; TERM then bounded KILL; verify cleanup.                                                                      |
| Cross-run state contamination                                  | Unique database, credentials, port, namespace, workspace, and run-bound digests.                                                                |
| Parser or request denial of service                            | Explicit byte/node/depth/ref/operation/regex/request/state/time limits.                                                                         |
| Secret under unexpected key leaks                              | Security-scheme locations, exact-secret registry, sensitive paths, patterns, and value detection.                                               |
| Agent games final prose                                        | Grade server evidence and final state first.                                                                                                    |
| Agent tampers with inputs                                      | Read-only input mount where possible; before/after hash verification.                                                                           |
| State/trace diverge on crash                                   | One SQLite transaction for state, response outcome, idempotency, and event.                                                                     |
| Evidence overwritten                                           | Exclusive creation and final hash manifest.                                                                                                     |
| Condition label or framework cue leaks to participant          | Exhaustive surface manifest, neutral profiles, rendered cue audit, pairwise diff allowlist, review artifact, and isolation reported separately. |
| Counterfactual changes canonical product truth                 | Immutable base digest, generated artifact root, allowlisted transform, canonical-byte regression, and explicit noncanonical lineage.            |
| Researcher pools incompatible or selectively excluded trials   | Locked estimand/denominators, exhaustive dispositions, compatibility-key refusal, immutable schedule, and derived-analysis lineage.             |
| Public mock abused                                             | Loopback default; explicit unsafe opt-in locally; TLS and tenant gateway if hosted.                                                             |
| Dependency compromise                                          | Lockfile, SBOM, provenance, scans, minimal interpreter dependencies.                                                                            |

## 29. Sandbox, network, and filesystem policy

### 29.1 Execution profiles

#### contract-safe

Default profile:

- Executes no pack code.
- Spawns no process from mock semantics.
- Performs no DNS or outbound connection.
- Opens no request-supplied host path.
- Reads only frozen contract/config and writes only private run state/evidence.
- Uses deterministic stand-ins for side effects.
- Allows participant tool execution to reach only the mock when the platform can
  enforce it.
- Mounts participant input read-only when possible.
- Keeps artifact/state paths unavailable to the participant.
- Mounts no Docker socket, SSH agent, browser profile, cloud config, or host
  credential store.

#### trusted-local

Allows an explicitly approved local behavior module. It is unsafe, never default
for third-party packs, prominently labeled, and forbidden in hosted mode.

#### isolated-extension

Allows behavior code only in a dedicated restricted process/container/WASM
runtime with bounded IPC, no network, scoped state, and resource controls.

#### live-proxy

Reserved and out of scope. The product MUST never fall back from mock to
upstream traffic.

### 29.2 Process separation

The architecture SHOULD separate:

1. Controller with provider connectivity.
2. Agent driver.
3. Model-generated tool executor.
4. Mock gateway.
5. Optional behavior runtime.
6. State/artifact writer.

If a third-party agent CLI cannot separate provider connectivity from
model-generated command egress, the isolation level is partial or advisory.

### 29.3 Network requirements

- **NET-001:** Local mock binds to 127.0.0.1 or an isolated namespace and uses
  an ephemeral port for trials.
- **NET-002:** Binding to 0.0.0.0, ::, or non-loopback requires
  **--allow-non-loopback** plus explicit local configuration. Hosted mode
  rejects it.
- **NET-003:** Mock and behavior runtime have deny-by-default egress.
- **NET-004:** Tool executor may reach only the specific mock socket where
  enforcement exists; other loopback ports are denied.
- **NET-005:** DNS, private networks, link-local, multicast, cloud metadata, and
  undeclared Unix sockets are denied to participant commands.
- **NET-006:** Participant contract rewrites root-, path-, and operation-level
  servers.
- **NET-007:** Remote references are denied during runs. A future ingestion
  fetcher must use HTTPS allowlists, redirect/private-network checks, limits,
  and content pinning outside the experiment.
- **NET-008:** Mocking URL upload, redirect, callback, webhook, or link never
  opens the target.
- **NET-009:** Readiness/admin uses a private file, descriptor, or socket
  unavailable in the participant namespace. A documentation facade, when
  selected, is participant support content only and has no access to control
  state.
- **NET-010:** Hosted data planes use TLS and tenant gateway auth separate from
  tested API auth.

### 29.4 Filesystem requirements

- **FS-001:** Every run has distinct input, workspace, output, state, evidence,
  and temporary roots.
- **FS-002:** Participant input includes only declared sanitized files.
- **FS-003:** State and evidence are invisible to the participant.
- **FS-004:** API paths are virtual and never resolved against the host.
- **FS-005:** User IDs are bounded safe filenames; pack paths cannot be
  absolute.
- **FS-006:** Local directories default to mode 0700 and sensitive files
  to 0600.
- **FS-007:** Exclusive creation refuses existing paths.
- **FS-008:** Archive preserves symlinks as inert metadata or rejects them;
  never dereferences. Device nodes, sockets, and FIFOs are excluded.
- **FS-009:** Cleanup operates only on validated per-run temporary roots created
  by the runner.
- **FS-010:** Cleanup never accepts filesystem root, a home directory, project
  root, or workspace root as a recursive deletion target.

### 29.5 Process lifecycle

- Spawn the adapter in a new process group/session when supported.
- Register shutdown handlers before agent launch.
- On completion, cancellation, timeout, or signal, send graceful termination to
  the complete group.
- Wait five seconds by default.
- Force terminate the group and enumerate lingering descendants.
- Mark **DESCENDANT_CLEANUP_FAILED** if a descendant remains.
- Close mock and private IPC before archive.

## 30. Credentials and redaction

### 30.1 Credential classes

1. **Provider credentials:** controller-only, high value, never enter
   participant environment or artifacts.
2. **Run API credentials:** unique short-lived dummy values satisfying contract
   security.
3. **Scenario fixture secrets:** synthetic values intentionally used in
   safe-handling tasks.

Real production API credentials are forbidden in contract and scenario modes.

Before freezing or copying a source document, ingestion scans descriptions,
examples, defaults, server variables, and extension values for high-confidence
secrets such as registered operator values, provider-key prefixes, private keys,
and explicit sensitive annotations. A high-confidence finding fails with
**OAL-INPUT-SECRET-DETECTED** and a source pointer; the value is never repeated
in the diagnostic. Pack authors must replace it with a synthetic placeholder.

Lower-confidence credential-shaped examples are marked sensitive. They are
redacted from the participant copy and are ineligible as contract-backend
response examples. Response selection falls through to a safe configured fixture
or schema generation and records **OAL-EXAMPLE-SENSITIVE-SKIPPED**.

### 30.2 Credential delivery

- Provider credentials remain in controller or a credential broker.
- Participant command environment inherits nothing by default.
- Only minimal PATH, locale if required, synthetic HOME/TMP, run ID, mock URL,
  and declared dummy credentials are injected.
- Credentials never appear in argv or readiness output.
- Generated run credentials use at least 256 bits of cryptographic randomness.
- Security emulation supports root and operation overrides, anonymous
  alternatives, OR/AND semantics, header/query/cookie API key, Basic, Bearer,
  and dummy OAuth/OIDC bearer values.
- Credentials exist only in memory and child environment or a protected per-run
  file/descriptor when required.

### 30.3 Redaction pipeline

Redaction runs before ordinary persistence or telemetry and combines:

- Locations derived from security schemes.
- Exact-value registry for every run secret.
- Configured sensitive headers, cookies, query keys, path parameters, JSON
  Pointers, form fields, and environment names.
- Case-insensitive key patterns for API key, token, secret, password,
  authorization, cookie, credential, and private key.
- Defensive recognition for Bearer, Basic, JWT-like, PEM private key, and known
  provider-key shapes.
- Pack annotation **x-agent-lab-sensitive: true**.

Coverage includes:

- Request/response headers and cookies.
- Query names/values.
- Configured path parameters and segments.
- JSON, form, multipart, XML, text, and binary metadata.
- Mock state and projections.
- Idempotency keys.
- Session events, stdout, and stderr.
- Participant final report.
- Evaluator and model-judge input/output.
- Exceptions and diagnostics.
- Metrics and tracing attributes.
- Archived participant workspace when it may contain injected dummy secrets.

### 30.4 Redaction representation

Where structured evidence permits:

```json
{
  "redacted": true,
  "kind": "bearer_token",
  "fingerprint": "hmac-sha256:4f13c9d2"
}
```

The fingerprint uses a run- or installation-specific HMAC key, never a plain
secret digest. Text contexts use **[REDACTED]**.

### 30.5 Raw capture

Unredacted request/session capture is disabled by default. If a future research
mode enables it, the capture must be separately encrypted, access-controlled,
retention-bounded, excluded from normal export/telemetry, and paired with
sanitized derived evidence.

### 30.6 Redaction canary

Tests register unique canary secrets in every supported location and assert
their literal values occur nowhere in:

- State exports.
- SQLite export.
- Trace.
- Documentation and semantic-event streams.
- Lifecycle, assignment, participant-surface, cue-audit, and compatibility
  artifacts.
- Session output.
- Participant report.
- Evaluation.
- Reports.
- Manifests.
- Metrics.
- Backend logs.
- Archived workspace.

Any leak is a release-blocking failure.

## 31. Resource limits and denial-of-service controls

### 31.1 Defaults and ceilings

Every limit is configurable downward. Local unsafe increases are explicit and
frozen. Hosted service enforces hard ceilings.

| Resource                             |    Default | Hard local/hosted ceiling |
| ------------------------------------ | ---------: | ------------------------: |
| Source OpenAPI bytes                 |     10 MiB |                    25 MiB |
| Total bundled document bytes         |     25 MiB |                    50 MiB |
| Parsed JSON/YAML nodes               |    100,000 |                   250,000 |
| Unique reference targets             |      2,000 |                     5,000 |
| Reference/schema traversal depth     |         64 |                       128 |
| Operations                           |      5,000 |                    10,000 |
| One example/default                  |      1 MiB |                     5 MiB |
| Retained examples total              |     10 MiB |                    25 MiB |
| Prompt/task/instructions total       |      2 MiB |                     5 MiB |
| StudyProtocol plus one PhasePlan     |      2 MiB |                     5 MiB |
| Study factors / levels per factor    |    16 / 32 |                  64 / 128 |
| Resolved study cells                 |        256 |                     1,000 |
| Contract variants per study          |         32 |                       128 |
| Frozen assignments per StudyRun      |      1,000 |                    10,000 |
| Participant-surface entries per cell |     10,000 |                    50,000 |
| Documentation candidates per profile |         16 |                        64 |
| Request target                       |     16 KiB |                    32 KiB |
| Request headers                      |     32 KiB |                    64 KiB |
| Request body                         |      5 MiB |                    25 MiB |
| Generated response body              |     10 MiB |                    25 MiB |
| Multipart parts                      |        100 |                     1,000 |
| SSE events per response              |        100 |                     1,000 |
| SSE duration                         | 30 seconds |                 5 minutes |
| Concurrent connections per run       |         32 |                       128 |
| Requests per run                     |     10,000 |                   100,000 |
| Burst rate                           | 100/second |              1,000/second |
| Domain objects                       |     10,000 |                   100,000 |
| Persisted state                      |    100 MiB |                   500 MiB |
| Event log                            |    100 MiB |                   500 MiB |
| All artifacts per run                |      1 GiB |                     5 GiB |
| Trial wall time                      | 30 minutes |         60 minutes hosted |
| Graceful process termination         |  5 seconds |                10 seconds |
| Batch trials                         |  1 default |                       100 |
| Parallel trials                      |  1 default |                  10 local |
| Extension memory                     |    512 MiB |                     1 GiB |
| Extension CPU                        |     1 core |                   2 cores |
| Extension process count              |         64 |                       128 |
| Schema worker deadline               |   1 second |              30 seconds |
| Schema worker processes              |          2 |                         8 |
| Schema worker queue                  | 128 pending |               1,024 pending |
| Schema worker message                |     8 MiB |                    32 MiB |
| Schema worker memory                 |   256 MiB |                     1 GiB |

### 31.2 Parsing controls

- YAML uses safe schema and alias-expansion limits.
- Duplicate JSON/YAML keys are errors.
- Compression is disabled by default; supported decompression has a byte
  ceiling.
- Cyclic references are traversed without stack overflow.
- Regex uses a safe engine, bounded inputs, or evaluation timeout.
- XML external entities and DTD resolution are disabled.
- Unknown encodings and malformed percent sequences yield bounded client errors.
- Diagnostic count is bounded to prevent error floods.

### 31.3 Runtime controls

- Return 413 for body limit, 414 for target limit, and 429 for request/rate
  quota.
- Validate before state mutation.
- Bound the request queue and apply backpressure.
- Never buffer an unbounded stream.
- Body previews stop at their limit while length and safe streaming digest
  continue.
- Model-token, agent-tool, API-request, provider-cost, disk, and wall-time
  budgets are independent.
- A limit event remains visible in evidence.
- When persistence limits prevent reliable finalization, the run is
  infrastructure-invalid rather than silently truncated.

## 32. Failure taxonomy

### 32.1 Diagnostic contract

```json
{
  "code": "OAL-REF-REMOTE-DISABLED",
  "phase": "compile",
  "severity": "error",
  "message": "Remote references are disabled.",
  "document": "openapi.yaml",
  "json_pointer": "#/paths/~1widgets/get/responses/200/content/application~1json/schema/$ref",
  "operation_key": "path:GET /widgets",
  "retryable": false,
  "details": {}
}
```

Programs depend on stable code, phase, severity, and retryable fields, not
message wording.

### 32.2 Categories

| Category         | Example stable codes                                                                                                                                          | Effect                                                       |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Input/config     | OAL-CONFIG-INVALID, OAL-INPUT-MISSING, OAL-INPUT-TOO-LARGE, OAL-PACK-SCHEMA-INVALID                                                                           | Batch setup fails before trials.                             |
| Parse            | OAL-JSON-INVALID, OAL-YAML-INVALID, OAL-YAML-ALIAS-LIMIT, OAL-DUPLICATE-KEY                                                                                   | Compile failure.                                             |
| OpenAPI          | OAL-OAS-VERSION-UNSUPPORTED, OAL-OAS-STRUCTURE-INVALID, OAL-OAS-ROUTE-AMBIGUOUS                                                                               | Error or capability outcome.                                 |
| References       | OAL-REF-NOT-FOUND, OAL-REF-OUTSIDE-ROOT, OAL-REF-REMOTE-DISABLED, OAL-REF-LIMIT                                                                               | Compile failure or scoped unsupported feature.               |
| Capability       | OAL-CAP-CALLBACK-UNSUPPORTED, OAL-CAP-AUTH-FLOW-UNSUPPORTED, OAL-CAP-SCHEMA-APPROXIMATED, OAL-PATTERN-HOSTILE                                                 | Strict blocker or explicit non-strict limitation.            |
| Pack             | OAL-PACK-DIGEST-MISMATCH, OAL-BEHAVIOR-OPERATION-MISSING, OAL-RUBRIC-INVALID                                                                                  | Setup failure.                                               |
| Study            | OAL-STUDY-SCHEMA-INVALID, OAL-PROTOCOL-LOCK-MISMATCH, OAL-PHASE-LOCK-MISMATCH, OAL-SCHEDULE-INVALID, OAL-CELL-DRIFT, OAL-CUE-LEAK, OAL-COMPATIBILITY-MISMATCH | Preflight failure or invalid analytical evidence.            |
| Startup          | OAL-PORT-BIND-FAILED, OAL-STATE-DIGEST-MISMATCH, OAL-ARTIFACT-EXISTS, OAL-MOCK-NOT-READY                                                                      | Infrastructure failure.                                      |
| Sandbox          | OAL-SANDBOX-UNAVAILABLE, OAL-FILESYSTEM-DENIED, OAL-NETWORK-DENIED, OAL-DESCENDANT-CLEANUP-FAILED                                                             | Infrastructure failure unless expected participant evidence. |
| Adapter/provider | OAL-AGENT-NOT-FOUND, OAL-AGENT-CAPABILITY-UNSUPPORTED, OAL-PROVIDER-AUTH-FAILED, OAL-PROVIDER-UNAVAILABLE                                                     | Preflight, provider, or infrastructure failure.              |
| Agent execution  | OAL-AGENT-EXIT-NONZERO, OAL-AGENT-TIMEOUT, OAL-AGENT-CANCELLED, OAL-AGENT-BUDGET-EXHAUSTED                                                                    | Valid unsuccessful agent outcome if evidence remains sound.  |
| HTTP behavior    | authentication_failed, route_not_found, method_not_allowed, request_schema_invalid, invalid_state, fault_injected                                             | Normal trace evidence.                                       |
| Mock             | OAL-GENERATION-FAILED, OAL-STATE-COMMIT-FAILED, OAL-MOCK-INTERNAL, OAL-SCHEMA-WORKER-TIMEOUT, OAL-SCHEMA-WORKER-FAILED, OAL-SCHEMA-WORKER-QUEUE-FULL, OAL-SCHEMA-WORKER-MESSAGE-TOO-LARGE | Infrastructure failure.                                      |
| Evaluation       | OAL-REPORT-MISSING, OAL-REPORT-INVALID, OAL-CHECK-FAILED, OAL-CHECK-INDETERMINATE, OAL-EVALUATOR-CRASHED                                                      | Task failure or evaluation infrastructure failure.           |
| Persistence      | OAL-ARTIFACT-WRITE-FAILED, OAL-HASH-MISMATCH, OAL-INVALID-EVIDENCE, OAL-DISK-LIMIT                                                                            | Infrastructure-invalid evidence.                             |

HTTP domain failures intentionally caused by a participant are not harness
failures.

### 32.3 Retry policy

- Do not retry agent behavior in the same trial.
- Do not retry participant API calls on its behalf.
- Safe startup/provider retries MAY happen before participant control if
  configured.
- Once participant control starts, every retry is a new immutable trial.
- New attempts record **retry_of** and reason.
- Failed attempts remain in the batch lineage and are never deleted.

### 32.4 Crash recovery

On controller restart:

- Discover incomplete run directories by write-once start without completion.
- Verify digests and SQLite integrity.
- Never relaunch an agent into the same run.
- Export recoverable trace/state evidence.
- Derive the original terminal disposition from persisted lifecycle facts and
  section 22.4 precedence; when no terminal transition was committed, use
  **harness_aborted** rather than guessing interruption or success.
- Allow operator to create a separate retry batch.
- For a StudyRun, derive harness-aborted from the lifecycle ledger, abort the
  immutable StudyRun when required by its PhasePlan, and never consume or
  reassign held slots during recovery.

## 33. Observability

### 33.1 Event families

In addition to **api.exchange**, **documentation.exchange**, and
**semantic.event**, internal redacted events include:

- run.created
- run.started
- run.cancelled
- run.finished
- compiler.diagnostic
- mock.started
- mock.stopped
- agent.started
- agent.session_event
- agent.exited
- process.terminated
- sandbox.denial
- resource.limit_reached
- evaluator.started
- evaluator.check
- evaluator.finished
- artifact.finalized
- lifecycle.stage
- assignment.activated
- assignment.finished
- study.aborted
- study.finished

Control-plane events are not exposed on the participant data plane.

### 33.2 Metrics

Bounded-cardinality metrics MAY include:

- Compile result by stable diagnostic code.
- Operation support-level counts.
- Run terminal classification.
- Study cell, assignment-kind, lifecycle-stage, evidence-integrity, and
  replacement counts using bounded registered labels.
- Request status class and validation category.
- Real request latency.
- State and artifact bytes.
- Agent duration, tool calls, tokens, and provider cost.
- Timeout, forced kill, and sandbox denial.
- Deterministic check status counts.
- Redaction action category without values.

Hosted metric labels MUST NOT contain raw paths, contract hashes, run IDs, user
text, pack-specific object IDs, or credential identifiers.

Local telemetry is off by default.

### 33.3 Evidence integrity

- A finalized run is immutable.
- Finalized StudyProtocol/PhasePlan locks, assignments, child batches, and
  StudyRun are immutable.
- Every artifact appears in the hash manifest or is explicitly missing.
- A retry gets a new ID.
- Reporting verifies hashes.
- Input mutation yields **invalid_evidence**.
- Undeclared participant-surface change, schedule mutation, compatibility drift,
  or state/semantic/parent-exchange contradiction yields **invalid_evidence**.
- Exports are derived from committed SQLite transactions.
- A corrupt trailing JSONL line cannot erase preceding valid records.

## 34. Testing strategy

### 34.1 Unit tests

Unit tests cover:

- JSON/YAML parse and duplicate keys.
- OpenAPI 3.0 and 3.1 normalization.
- Reference resolution, cycles, traversal, and limits.
- Operation identity and collision handling.
- Route precedence and percent decoding.
- Parameter serialization matrix.
- Media/status selection.
- Schema generation for every supported keyword.
- Security OR/AND evaluation.
- Redaction in every location.
- Virtual clock, seeded generation, and namespaced randomness.
- Idempotency conflict/replay.
- State transaction and rollback.
- Capability diagnostic stability.
- Template rendering safety.
- Failure classification.
- Artifact hashing and manifest verification.
- Resource limits.
- StudyProtocol, PhasePlan, factor, cell, and lock validation.
- Protocol-lock non-self-referential hashing and post-start immutability.
- Deterministic blocked assignment, held replacements, and replacement ceilings.
- Participant-surface inventory, provenance classification, cue scans, and
  pairwise diff allowlists.
- ContractVariant patch allowlists, common-projection equality, and
  canonical-contract immutability.
- Lifecycle stage transitions, terminal-disposition precedence, and
  evidence-integrity classification.
- Compatibility-key construction, denominator selection, and preregistered
  statistical reference vectors.
- Typed metric-source, contrast/stratum reference, evidence-requirement, and
  missingness validation.
- Replacement activation-to-primary mapping and inherited block/stratum
  completeness.

### 34.2 Compiler golden tests

Every corpus document compiles to checked-in ContractIR and capability output.
Golden updates require explicit review.

Golden assertions:

- Stable operation order, keys, UIDs, and tool names.
- Every source operation represented.
- No unsupported feature silently disappears.
- Correct source and semantic digests.
- Stable diagnostic codes and pointers.
- Byte-deterministic output.
- Semantically equivalent JSON/YAML semantic digest equality.
- Repeated materialization of a locked ContractVariant produces byte-identical
  contract, documentation, and diff artifacts.

### 34.3 Black-box mock conformance

Start a real loopback mock and use only HTTP or MCP. Assert:

- No undeclared product data-plane routes; a documentation facade serves only
  the frozen conventional candidates declared by the study.
- Correct 401/403/404/405 distinction.
- Validation precedes mutation.
- Successful responses validate against OpenAPI.
- Restart preserves matching state.
- Runs share no state.
- Idempotent replay is exact.
- Concurrent mutation is serialized.
- Invalid requests do not mutate.
- Binary, multipart, form, JSON, text, XML, SSE, and empty responses obey
  limits.
- URL values cause no network.
- Command values create no process.
- Virtual paths touch no host path.
- Every event is redacted with correct state revisions/digests.
- File, discoverable, tool-only, and none visibility expose exactly their
  declared participant surfaces.
- Documentation exchanges remain separate from product API exchanges and never
  increase operation-attempt counts.
- A documentation candidate colliding with a declared product method/path fails
  preflight and never shadows the operation.
- **externalDocs** strip, preserve-reference, and bundle-declared policies are
  deterministic, perform zero network requests, and expose only their frozen
  declared surface.

### 34.4 Scenario-pack conformance

A pack is publishable only when:

- Manifest/API versions are supported.
- Contract digest/compatibility declaration matches.
- Every declared operation key exists.
- Exact completeness passes where selected.
- Initial state validates.
- Every transition is deterministic.
- Behavior examples and test results validate against declared responses.
- Every rubric compiles.
- Fault schedules reproduce from the seed.
- Restart/replay passes.
- Fallback is explicit.
- Hidden inputs are absent from participant data plane and workspace.
- Semantic events are schema-valid, emitted atomically with committed state, and
  reproduce under replay.
- Variant adapters preserve the declared shared facts, transition kernel, and
  semantic-event vocabulary.

### 34.5 Runner integration tests

Fake, non-billable agent executables test:

- Workspace construction.
- Root/path/operation server rewriting.
- Read-only inputs.
- Synthetic HOME/TMP.
- Environment allowlist.
- Native output-schema handoff.
- Session/stderr capture.
- Process-tree cleanup.
- Timeout/cancellation.
- Mock shutdown.
- Symlink-safe archive.
- Unique port/state/key/workspace across parallel trials.
- Existing batch refusal.
- Zero-request denominator.
- Missing/malformed output.
- Partial batch recovery.
- Artifact hash validation.
- Direct/catalog MCP setup and teardown.
- Conservative control-start detection and every pre-control/post-control
  terminal-disposition branch.
- Terminal-disposition precedence when timeout, provider, participant, and
  operator signals race.
- Crash recovery at each lifecycle stage without turning an unfinished trial
  into a completed trial.
- Fail-fast batch-wide defects leave remaining planned assignments as
  **not_started** and replacements as held.
- A StudyRun interleaves assignments globally while every child batch remains a
  homogeneous experiment cell.
- Final participant-surface verification detects any rendered material or route
  not frozen at preflight.

### 34.6 Security/adversarial tests

Prove:

- Participant cannot read a host sentinel under hard isolation.
- Participant cannot read state, trace, rubric, or sibling run.
- Tool executor cannot reach internet sink, production hostname, unrelated
  loopback port, or cloud metadata.
- Mock and extension runtime cannot connect outbound.
- References cannot escape by parent segment, symlink, encoding, redirect, or
  URI scheme.
- URL upload never fetches.
- Exec request never creates a marker process or file.
- YAML aliases, deep schemas, cycles, large bodies, multipart floods, regex
  bombs, and connection floods fail within limits.
- Canary secrets occur nowhere in exports.
- Templates cannot execute interpolation code.
- Behavior runtime cannot access forbidden environment, host paths, network, or
  sibling run under isolated mode.
- Participant symlinks are not dereferenced.
- Reused run IDs and mismatched state digests are rejected.
- TERM/KILL removes descendants.
- Hidden canary and prohibited-cue fixtures are absent from every
  participant-readable surface and export.
- Strict-blinding surface differences outside the approved allowlist invalidate
  evidence.
- ContractVariant materialization cannot overwrite, relabel, or silently promote
  the canonical product contract.

### 34.7 Fuzz and property tests

Generate:

- Valid/invalid paths and percent encodings.
- Parameter style/explode combinations.
- Recursive/composed schemas.
- Boundary JSON instances.
- Stateful request sequences.
- Idempotency keys and body conflicts.
- Concurrent schedules.
- Nested redaction shapes.
- Parser failures.

Invariants:

- No HTTP request crashes the mock.
- Invalid requests never mutate domain state.
- Event sequences are strictly monotonic.
- Participant API/documentation ingress sequences are globally unique and
  preserve controller-observed order under concurrent/tied timestamps.
- Every successful generated response validates.
- Same seed and request sequence produce the same normalized logical trace and
  final state.
- No registered secret occurs in serialized evidence.
- No request causes undeclared host filesystem, process, or network activity.

### 34.8 Real-agent evaluation tests

Paid tests run only by explicit command or scheduled workflow. They pin:

- Adapter and agent version.
- Model and effort.
- Prompt/task/contract/pack/rubric digests.
- Sandbox.
- Count and parallelism.
- Token, request, cost, and time ceilings.
- StudyProtocol, PhasePlan, protocol lock, phase lock, assignment schedule,
  ContractVariant, participant-surface template, compatibility key, and
  implementation digest.

Sequential execution is the default baseline. Model-backed regression thresholds
use planned cohorts and uncertainty, never replace deterministic component
tests.

Paid real-agent smoke trials are labeled non-analytical and excluded from
primary estimates. Analytical cohorts start only after all no-paid preflight and
synthetic conformance gates pass.

### 34.9 StudyProtocol conformance

The reference study suite MUST include deterministic fixtures for:

- A single-factor, two-cell balanced design.
- A factorial design with at least one blocked nuisance factor.
- Unequal planned cell counts that are rejected unless explicitly declared.
- A held replacement activated for an eligible pre-control failure.
- A post-control participant/task failure that remains in its original
  assignment and is not replaced.
- A preregistered post-control instrumentation censor that activates the
  matching held replacement while retaining the original attempt; the main
  analysis uses the replacement for one slot and the worst-case analysis uses
  one failure for that same slot, never two observations.
- A pre-control nonparticipant original followed by a control-started censored
  replacement; the main slot is unresolved and its worst-case value is exactly
  one failure.
- One cell-level reserve substituting a failure from either primary block
  through an immutable activation mapping, plus an unresolved block that
  correctly refuses the registered estimate.
- The exhaustive censor-class precedence across pre-control, operator
  interruption, harness recovery, missing/corrupt required evidence, intact
  participant failures, and intact post-control infrastructure outcomes,
  including persisted reason/requirement IDs.
- A mutated protocol or phase lock rejected after the first paid analytical
  **participant_spawned** stage.
- A compatibility-key mismatch that fails inferential analysis before pooling.
- A strict-blinding cue leak detected in a filename, prompt,
  environment-variable name, credential shape, documentation response, tool
  description, and adapter message.
- A documentation facade whose frozen localized contract bytes match the
  file-delivered counterpart.
- A counterfactual ContractVariant whose patch is within its allowlist and whose
  semantic parity checks pass.
- A counterfactual ContractVariant with handler, documentation, or semantic
  drift that fails preflight.
- A study-directory inline handler/dynamic module path that is rejected, plus a
  counterfactual whose pinned adapter resolves only from a separate immutable
  research PackRef.
- A custom evaluator rejected in safe mode and admitted only in an explicit
  trusted or isolated profile.
- An unresolved metric/check/contrast level/stratum and a missing required
  primary evidence stream rejected, while a missing optional usage input yields
  **unknown** without globally invalidating evidence.

Statistical tests MUST use checked-in numeric reference vectors for Wilson
intervals, Newcombe difference intervals, Fisher exact tests, Holm correction,
weighted estimands, worst-case censor bounds, and any supported paired method.
At minimum, independent fixtures assert Wilson 95% for 5/10 is approximately
**[0.236593, 0.763407]**, the symmetric Newcombe interval for 5/10 minus 5/10 is
approximately **[-0.372514, 0.372514]**, two-sided Fisher exact for
**[[1, 9], [8, 2]]** is approximately **0.00547749**, and Holm adjustment of
**[0.01, 0.04, 0.03]** is **[0.03, 0.06, 0.06]** in original order. Tests
compare against frozen tolerances and never generate their expected values with
the implementation under test. The implementation MUST report undefined
estimates instead of inventing values for empty denominators.

## 35. OpenAPI conformance corpus

### 35.1 Corpus manifest

```yaml
id: parameters-style-matrix
source: fixtures/parameters-style-matrix/openapi.yaml
sha256: DIGEST
expected:
  compile: success
  supported_operations: 24
  approximated_operations: 0
  diagnostics: []
cases: cases.yaml
security_assertions:
  outbound_requests: 0
  secret_leaks: 0
```

External fixtures must be license-compatible, pinned by hash, recorded with
origin/license, and never fetched during CI.

### 35.2 Document formats and versions

- OpenAPI 3.0.0 and 3.0.3.
- OpenAPI 3.1.0 and later supported 3.1 patch versions.
- JSON and YAML.
- Unicode text and identifiers.
- Minimal valid document.
- Thousands-of-operations synthetic document.
- Malformed JSON/YAML.
- Duplicate keys.
- Unsupported 2.0 and 3.2 diagnostics.

### 35.3 References

- Internal JSON Pointer.
- Same-pack relative files.
- Escaped pointer tokens.
- Cycles and recursive schemas.
- Missing target.
- Sibling values around ref in 3.0 and 3.1.
- Parent traversal and symlink escape.
- Remote HTTP/HTTPS, file, data, custom schemes.
- Excessive breadth/depth.

### 35.4 Paths and operations

- Literal versus parameter route.
- Multiple parameters.
- Valid/malformed percent encoding.
- Empty/trailing segments.
- Root/path/operation servers.
- Server variables.
- Missing/duplicate operationId.
- All eight path methods.
- Webhooks and callbacks.
- Deprecated operations.
- Empty paths.
- Equivalent ambiguous templates.

### 35.5 Parameters

- Path/query/header/cookie.
- Required/optional/default.
- simple, form, matrix, label, spaceDelimited, pipeDelimited, deepObject.
- explode true/false.
- Repeated query values.
- Arrays and objects.
- Case-insensitive headers.
- Parameter content.
- Inheritance conflicts.
- Empty and reserved characters.

### 35.6 Request bodies

- JSON and structured suffix JSON.
- Plain text.
- Octet stream.
- URL-encoded form.
- Multipart text/binary.
- XML with external entities disabled.
- Required/optional.
- Multiple media types.
- Empty versus null.
- Oversize.
- Streaming declarations.

### 35.7 Responses

- 200, 201, 202, 204, other 2xx, ranges, default.
- Empty response.
- Multiple media types.
- Header/cookie schemas.
- Inline/named/schema examples.
- const/default/enum.
- Binary.
- SSE.
- Links.
- No schema.
- No declared success.

### 35.8 JSON Schema

- Primitive and union types.
- OpenAPI 3.0 nullable.
- const, enum, default, examples.
- Bounds.
- Formats.
- additionalProperties.
- allOf, oneOf, anyOf, not.
- Discriminator.
- readOnly/writeOnly.
- prefixItems, contains, dependentSchemas, 3.1 dialect features.
- Recursion.
- Unsatisfiable schemas.
- Large patterns and depth.

### 35.9 Security

- Anonymous.
- Global with operation override.
- API key header/query/cookie.
- Basic/Bearer.
- Dummy OAuth/OIDC.
- OR and AND requirements.
- Missing/malformed credentials.
- Secret canaries in examples, errors, query, cookie, path, body, response,
  state, session, and idempotency.

### 35.10 Adversarial fixtures

- Prompt injection in descriptions/examples.
- Production servers.
- Metadata/local URLs.
- Redirect to private address.
- YAML alias bomb.
- Deep reference graph.
- Regex denial of service.
- Huge example/default.
- HTML/script content.
- NUL/control characters.
- Encoded traversal.
- Credential-shaped value under neutral key.
- Duplicate IDs and ambiguous routes.
- Scenario undeclared state writes.
- Behavior attempts filesystem/process/network.

### 35.11 Real-world shapes

The corpus SHOULD add sanitized, license-approved pinned snapshots representing:

- Small CRUD API.
- Large multi-tag cloud API.
- Multiple security alternatives.
- Binary/file API.
- Multipart API.
- Deeply referenced generated SDK contract.
- OpenAPI 3.0 nullable-heavy API.
- OpenAPI 3.1 recursive-schema API.

No external snapshot is fetched during normal test execution.

## 36. CI and release gates

### 36.1 Pull-request gates

Every pull request passes the gates applicable to the current delivery
milestone; a gate becomes permanently required once its package/phase lands:

1. Formatting, lint, typecheck, and package-boundary checks.
2. Unit tests.
3. Compiler golden corpus without unreviewed differences.
4. Black-box HTTP conformance; add MCP conformance permanently when Phase 7
   lands.
5. Steel golden-pack parity.
6. Fake-agent runner integration.
7. Determinism: identical seeded runs have byte-identical normalized logical
   trace, state, and evaluation.
8. Isolation: parallel runs share no state, port, credential, workspace, or
   evidence.
9. Redaction canary with zero leaks.
10. No outbound network.
11. No host process/filesystem side effect.
12. Restart/replay and crash recovery.
13. CLI help/config schema snapshots.
14. Dependency license and vulnerability scan.
15. Repository secret scan.
16. StudyProtocol/PhasePlan schema, lock, assignment, and immutability goldens
    once Phase 6 lands.
17. Participant-surface inventory, strict cue-scan, and approved-diff checks
    once Phase 6 lands.
18. ContractVariant allowlist, canonical-immutability, handler-parity,
    documentation-parity, and semantic-parity checks once Phase 6 lands.
19. Atomic semantic-event and separate documentation-exchange conformance once
    Phase 6 lands.
20. Compatibility-key, denominator, replacement, and statistical
    numeric-reference tests once Phase 6 lands.

No pull-request test invokes a paid model by default.

### 36.2 Nightly gates

- Extended fixed-duration fuzzing.
- Linux and macOS local runner.
- Supported Node patch matrix.
- Container isolation integration.
- Large-document performance.
- Concurrent and forced-crash recovery.
- Hosted tenant isolation when implemented.
- Pinned, cost-capped, explicitly approved real-agent cohorts whose protocol and
  phase locks are already immutable.
- Variance, disposition, evidence-integrity, replacement, and denominator report
  for model-backed evals.
- Repeated same-seed schedule materialization and shuffled-order balance checks.

### 36.3 Release gates

- PR and nightly gates green.
- No unwaived critical/high dependency or image vulnerability.
- SBOM and signed provenance.
- Non-root container when a container is published.
- Clean install and package/binary smoke test.
- Artifact/state/API-event/semantic-event/documentation-event/study schema
  compatibility tests.
- Supported pack and schema version matrix.
- Reproducible corpus output.
- Executable documentation examples.
- Published capability matrix matches implementation.
- Retention and redaction review for hosted releases.

### 36.4 Performance budgets

On a documented reference CI machine:

- A 1 MiB, 500-operation contract SHOULD compile within 2 seconds p95 and below
  512 MiB RSS.
- A simple schema-validated contract request SHOULD complete within 50 ms p95
  excluding connection setup.
- A 500-operation server SHOULD become ready within 2 seconds.
- Limit violations MUST terminate promptly without memory growth materially
  beyond configured bounds.

Performance data is reported raw. Performance never justifies weakening
validation, determinism, or security controls.

## 37. External component strategy

### 37.1 Stoplight Prism

Stoplight Prism is the default version 0.1 contract-response adapter because it
already supports OpenAPI request validation, response examples, schema-based
generation, and content negotiation. A built-in deterministic generator remains
required for controlled fallback and differential verification.

It MUST sit behind **MockAdapter**, not define product contracts.

Requirements:

- OAL remains the only participant-facing gateway.
- ContractIR remains the only canonical interpretation.
- The Prism adapter receives a frozen, canonical, single-operation derived
  contract or normalized operation request. It never receives authority to
  discover the participant-facing route.
- Prism cannot add routes or admin endpoints.
- OAL owns authentication emulation, limits, transaction boundaries, event
  shape, redaction, and final response validation.
- Prism version is pinned and frozen in run metadata.
- Golden/differential tests detect behavioral changes on upgrades.
- Unsupported Prism behavior is replaced operation-by-operation by the built-in
  generator according to a frozen adapter capability map.
- Prism is used for deterministic example resolution and compatibility
  validation. Schema-only value generation is always delegated to OAL’s seeded
  built-in generator unless a pinned Prism release exposes and passes a
  seed-determinism conformance test.
- For identical ContractIR operation, validated request, response-selection
  policy, and seed, MockAdapter output MUST be byte-identical.
  Preflight/conformance invokes representative candidates twice and rejects an
  adapter that violates this invariant.
- The derived single-operation document is round-trip checked against the
  expected canonical key, serializers, security, request media types, and
  response selectors before it is cached.
- A Prism route mismatch or candidate that does not validate is an adapter
  failure; it never changes gateway routing.
- It is forbidden to allow two disagreeing parsers to choose participant-facing
  routes independently.

### 37.2 Microcks

Microcks is not a version 0.1 runtime dependency. A later adapter MAY provide:

- An alternative stateful mock backend.
- Imported dispatch/state scripts in an explicitly unsafe or isolated mode.
- MCP exposure interoperability.

It MUST still emit the OAL normalized trace and follow OAL artifact, security,
and experiment-cell rules. A Microcks-backed cohort is a separate backend
treatment from the built-in/Prism backend.

### 37.3 Schemathesis

Schemathesis is a separate conformance lane, not the agent evaluator.

It SHOULD:

- Exercise the generated mock before a pack is published.
- Test stateful operation sequences where supported.
- Verify generated responses against the contract.
- Run as CI/preflight control evidence.

Schemathesis traffic uses actor **control** and never appears as participant
behavior in an agent trial.

### 37.4 Arazzo

Use the OpenAPI Initiative Arazzo specification for portable workflow
descriptions. OAL’s supported Arazzo version and runtime-expression subset are
explicit in the capability report. Arazzo does not replace pack state
assertions.

### 37.5 Dependency governance

- Every external component is behind an internal interface.
- Lock exact resolved versions in the workspace lockfile.
- Record dependency version in relevant artifacts.
- Upgrade through a dedicated golden-output review.
- Do not expose third-party diagnostic strings as stable API.
- Do not permit dependency defaults to create network, filesystem,
  documentation, CORS, or admin behavior.

## 38. State-store schema and IPC contracts

### 38.1 SQLite schema

The exact physical schema may evolve through numbered migrations, but version 1
MUST represent these logical records:

```sql
CREATE TABLE schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE run_meta (
  run_id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  contract_semantic_sha256 TEXT NOT NULL,
  contract_execution_sha256 TEXT NOT NULL,
  source_inventory_sha256 TEXT NOT NULL,
  pack_sha256 TEXT,
  scenario_sha256 TEXT,
  contract_variant_sha256 TEXT,
  backend_sha256 TEXT NOT NULL,
  implementation_sha256 TEXT NOT NULL,
  seed TEXT NOT NULL,
  state_schema_version INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE participant_ingress (
  participant_ingress_sequence INTEGER PRIMARY KEY,
  ingress_id TEXT NOT NULL UNIQUE,
  plane TEXT NOT NULL CHECK (plane IN ('api', 'documentation')),
  observed_at TEXT NOT NULL
);

CREATE TABLE domain_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  revision INTEGER NOT NULL,
  logical_time TEXT NOT NULL,
  state_ciphertext BLOB NOT NULL,
  state_nonce BLOB NOT NULL,
  state_evidence_digest TEXT NOT NULL
);

CREATE TABLE requests (
  sequence INTEGER PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  participant_ingress_sequence INTEGER UNIQUE
    REFERENCES participant_ingress(participant_ingress_sequence),
  ingress_observed_at TEXT NOT NULL,
  operation_key TEXT,
  method TEXT,
  path_redacted TEXT,
  terminal_status TEXT NOT NULL,
  response_status INTEGER,
  committed INTEGER NOT NULL CHECK (committed IN (0, 1))
);

CREATE TABLE events (
  sequence INTEGER PRIMARY KEY REFERENCES requests(sequence),
  event_id TEXT NOT NULL UNIQUE,
  event_json TEXT NOT NULL,
  event_sha256 TEXT NOT NULL
);

CREATE TABLE semantic_events (
  semantic_sequence INTEGER PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  request_sequence INTEGER NOT NULL REFERENCES requests(sequence),
  parent_event_id TEXT,
  event_name TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  event_json TEXT NOT NULL,
  event_sha256 TEXT NOT NULL
);

CREATE INDEX semantic_events_request
  ON semantic_events(request_sequence, semantic_sequence);

CREATE TABLE documentation_exchanges (
  documentation_sequence INTEGER PRIMARY KEY,
  exchange_id TEXT NOT NULL UNIQUE,
  participant_ingress_sequence INTEGER UNIQUE
    REFERENCES participant_ingress(participant_ingress_sequence),
  observed_at TEXT NOT NULL,
  method TEXT NOT NULL,
  path_redacted TEXT NOT NULL,
  response_status INTEGER NOT NULL,
  response_sha256 TEXT NOT NULL,
  event_json TEXT NOT NULL,
  event_sha256 TEXT NOT NULL
);

CREATE TABLE idempotency (
  operation_key TEXT NOT NULL,
  principal_key TEXT NOT NULL,
  normalized_path_sha256 TEXT NOT NULL,
  idempotency_key_hmac TEXT NOT NULL,
  request_hmac TEXT NOT NULL,
  response_ciphertext BLOB NOT NULL,
  response_nonce BLOB NOT NULL,
  created_sequence INTEGER NOT NULL,
  PRIMARY KEY (
    operation_key,
    principal_key,
    normalized_path_sha256,
    idempotency_key_hmac
  )
);

CREATE TABLE blobs (
  blob_id TEXT PRIMARY KEY,
  sha256 TEXT,
  secret_hmac TEXT,
  bytes INTEGER NOT NULL,
  media_type TEXT,
  relative_path TEXT NOT NULL UNIQUE,
  created_sequence INTEGER,
  CHECK (
    (sha256 IS NOT NULL AND secret_hmac IS NULL)
    OR
    (sha256 IS NULL AND secret_hmac IS NOT NULL)
  )
);
```

Rules:

- Enable foreign keys.
- Use WAL unless the selected filesystem makes WAL unsafe; record fallback.
- Set bounded busy timeout.
- Do not share one database across runs.
- Canonical state is reduced through the security-aware evidence projection
  before its exported state digest is calculated. Raw secret-bearing state uses
  a keyed internal integrity tag, never an unkeyed digest.
- Encrypt domain state and replayable idempotency responses with authenticated
  encryption before they reach SQLite, including WAL pages.
- Keep the per-run data-encryption key in the private control directory with
  mode 0600, never in participant or finalized evidence. Destroy it after
  evaluation/finalization. Crash recovery is possible only while that private
  key remains.
- API-event, semantic-event, and documentation-event JSON is already redacted
  before persistence.
- A behavior result's response candidate, next state, idempotency record, API
  exchange, and semantic events commit in one transaction or not at all.
- A documentation exchange uses its own monotonic sequence and transaction. It
  cannot read or mutate domain state, create an API exchange, or affect
  API-operation denominators.
- Participant-originated API and documentation transactions each insert exactly
  one matching **participant_ingress** row. Shared sequence uniqueness and plane
  linkage are verified during export; control traffic leaves the nullable
  foreign key empty and uses its separate control ordering.
- The requests table stores only the security-aware redacted path. Raw target,
  query, cookies, headers, and bodies exist only in bounded request-processing
  memory or encrypted secret-bearing state.
- Idempotency key identity and normalized request identity use HMAC, not raw
  digest.
- Database migrations run only before the listener starts.
- A migration never occurs automatically during evidence replay.
- Evaluators access final internal state through the scoped state-store reader
  before key destruction. Persisted **state.final.json** and
  **state.summary.json** are redacted evaluator evidence; sensitive values
  become HMAC fingerprints where equality is required.
- Blob contents are encrypted at rest when retained. Non-sensitive binary
  evidence uses a SHA-256 blob ID. A registered-secret-bearing payload uses an
  internal HMAC ID, has no exported SHA-256/blob file, and is removed with the
  private control key after evaluation.

### 38.2 Behavior IPC

Messages are length-prefixed JSON with an explicit protocol version. Binary
content travels through scoped blob references or bounded binary frames, never
unbounded base64 in JSON. A successful **handle_result** returns one bounded
response candidate, an optional next-state value, and zero or more schema-valid
semantic events as one indivisible controller input; the backend never claims
that any of them committed.

Message families:

- hello / hello_ok / hello_error
- describe / describe_result
- initialize / initialize_result
- handle / handle_result / handle_error
- project / project_result
- close / close_result

Every request has a monotonically increasing IPC message ID and deadline.
Unknown protocol version, extra required capability, oversized frame, malformed
JSON, duplicate response, or response after deadline terminates the backend and
marks infrastructure failure.

The backend cannot ask the controller to:

- Read an arbitrary file.
- Open a URL.
- Spawn a process.
- Read environment variables.
- Reveal credentials.
- Mutate another run.

### 38.3 MockAdapter interface

```ts
export interface MockAdapter {
  readonly id: string;
  readonly version: string;
  probe(contract: ContractIR): Promise<MockCapability>;
  initialize(context: ContractBackendContext): Promise<void>;
  respond(
    request: ValidatedContractRequest,
    context: DeterministicResponseContext
  ): Promise<ContractResponseCandidate>;
  close?(): Promise<void>;
}
```

The gateway validates every candidate. An adapter cannot commit state, write
trace, select routes, authenticate, or access raw credentials.

### 38.4 Artifact-writer interface

Only the evidence package writes finalized evidence. Components submit typed
records. The writer:

- Validates record schemas.
- Redacts again at the boundary.
- Uses atomic create/rename for single JSON files.
- Uses append plus flush for JSONL.
- Uses content-addressed exclusive blob writes.
- Calculates hashes while writing.
- Refuses path traversal and unexpected artifacts.

## 39. Steel Computer migration

### 39.1 Migration source

The first pack is migrated from:

```text
/Users/nikola/dev/steel/steel-v2/experiment
```

Important inputs:

- **../openapi.json** from the Steel v2 repository root.
- **mock-server.mjs**
- **run-codex.mjs**
- **analyze.mjs**
- **agent-instructions.md**
- **task.md**
- **prompt.txt**
- **result.schema.json**
- Existing test files and golden run artifacts.

The Steel source repository remains its own source of truth. Migration copies
frozen inputs into the new pack; it does not edit the original **source/**
mirror.

### 39.2 Current prototype properties to preserve

- Contract-derived route discovery.
- Startup refusal when a declared operation lacks a high-fidelity handler.
- Exactly 37 declared operations.
- Loopback random-port mock per run.
- Unique per-run API key, state, trace, workspace, and temporary environment.
- Request-body limit.
- Constant-time credential comparison.
- Recursive credential redaction.
- Complete traces for accepted and rejected requests.
- State bound to run and contract digest.
- Restart inside the same matching run.
- No data-plane reset endpoint.
- Safe stand-ins for exec, URL, SSH, preview, and other apparent side effects.
- Immutable batch IDs and frozen input hashes.
- Synthetic participant HOME/TMP and filtered environment.
- Participant workspace outside the source repository.
- Process-group cleanup.
- Trace/final-state scoring.
- Failed and zero-request trials retained.
- Existing ten automated tests.

### 39.3 Migration mapping

| Current concern                 | New owner                                |
| ------------------------------- | ---------------------------------------- |
| Route parsing and matching      | openapi compiler + gateway               |
| Request parsing/auth/validation | gateway                                  |
| Generic state persistence       | state-store                              |
| Generic redaction/event output  | evidence                                 |
| 37 Steel operation handlers     | packs/steel-computer/behavior            |
| Initial Steel state             | Steel fixtures + behavior initialization |
| Agent instructions/task/launch  | Steel prompt set and task                |
| Result schema                   | Steel task schema                        |
| Ordered recovery rubric         | Steel rubric                             |
| Steel diagnostic probe signals  | Steel signals in rubric                  |
| Generic aggregation/reporting   | evaluator + report                       |
| Codex process invocation        | runner + agent-codex                     |
| Fake Codex integration          | adapter and runner conformance test      |

### 39.4 Steel pack structure

```text
packs/steel-computer/
  pack.yaml
  contract/
    openapi.json
  behavior/
    index.ts
  fixtures/
    baseline.json
    system-templates.json
  prompts/
    diagnostic/
      instructions.md
      launch.txt
  tasks/
    checkpoint-recovery/
      task.md
  schemas/
    steel-state.schema.json
    checkpoint-recovery-result.schema.json
  evals/
    checkpoint-recovery/
      rubric.yaml
  workflows/
    checkpoint-recovery.arazzo.yaml
  tests/
    contract.test.ts
    behavior.test.ts
    runner.test.ts
    evaluator.test.ts
```

### 39.5 Steel parity requirements

- Exactly all 37 operations are reachable and exact completeness passes.
- No undeclared health, reset, admin, documentation, or introspection endpoint
  appears.
- API key behavior and redaction remain intact.
- Computer lifecycle, guest wake, files, environment, checkpoints, in-place
  restore, checkpoint ownership, templates, previews, SSH stand-ins, usage,
  sessions, idempotency, SSE, binary data, persistence, and run isolation retain
  frozen semantics.
- No payload executes a host command, touches a request-supplied host path, or
  fetches a URL.
- The checkpoint-recovery fake-agent trial passes all current invariants.
- Zero-request and malformed-report outcomes remain in denominators.
- Descendants terminate on completion and timeout.
- The participant sees only declared materials.
- Contract, participant copy, prompts, task, instructions, schema, behavior,
  rubric, adapter, and core are hashed.
- Steel signals remain observable: unknown endpoint, wrong method, invalid
  transition, checkpoint-on-create attempt, invented fork/clone/snapshot,
  invented browser routes, manual resume, idempotency, argv versus shell exec,
  streaming, and malformed file paths.

### 39.6 Known migration drift

The current broader Steel contract permits stopping a running or paused
computer, while the prototype handler accepts only running. Migration version
1.0 MUST preserve the frozen prototype behavior so old experimental results
remain comparable and MUST document the discrepancy in pack diagnostics.

A correction requires:

- A deliberate Steel pack version bump.
- Changelog entry.
- Updated behavior tests.
- Contract/behavior decision confirmed against the Steel source-of-truth
  documents.
- A new cohort rather than mixing results.

The Steel pack MUST also preserve the source decision that version 1 cannot
create a computer from a checkpoint. It MUST NOT add checkpoint_id to computer
creation. The future fork concept remains outside this migration.

### 39.7 Migration sequence

1. Freeze source digests and representative golden traces.
2. Build generic ContractIR and compile Steel with 37 operation keys.
3. Port gateway mechanisms without handlers.
4. Port behavior handlers behind the backend interface.
5. Port exact-completeness startup check.
6. Port fake-agent runner through the generic adapter.
7. Port rubric and signals into declarative evaluation.
8. Run old and new implementations against identical scripted requests.
9. Compare status, contract-visible body/header, state digest/projection, and
   signals.
10. Document intentional differences.
11. Mark Steel pack golden only after all parity tests and current ten tests
    pass.

### 39.8 Noncanonical Steel research protocol

The reusable design from **Steel Plan 001: Turn the mock harness into a blinded
agent-native API design lab** is adopted as a StudyProtocol example, not as a
change to Steel pack 1.0 or the canonical Steel API.

The project SHOULD ship two separately versioned and content-addressed
artifacts:

- **packs/steel-computer-agent-native-research/** is an immutable research Pack
  with ID **steel-computer-agent-native-research**, version **1.0.0**, and a
  manifest **based_on** the exact canonical **steel-computer@1.0.0** Pack
  digest. It owns the dormant variant adapters, shared
  **computer.create_from_checkpoint** semantic action, behavior registry,
  semantic-event registry/schemas, common projection, variant
  patch/static-contract assets, and the authoritative Eval with its neutral
  PromptSet, task, instructions, result schema, rubric, and documentation
  assets. The canonical control resolves no saved-state-creation adapter; each
  counterfactual selects only its declared research-Pack adapter.
- **studies/steel-agent-native-checkpoint-v1/** contains only the frozen
  StudyProtocol, PhasePlans, PackRef/EvalRef/ContractVariantSet selectors,
  documentation/surface selection policies, assignment fixtures, analysis plan,
  reviews, and source provenance needed to reproduce the study. It contains no
  authoritative participant material, handler, executable behavior, evaluator
  implementation, or independent semantic registry.

The StudyProtocol pins the research PackRef and EvalRef by ID/version/digest.
Contract variants are materialized under the StudyRun from those pinned
declarative assets and adapter selectors. Any task, prompt, instructions,
result-schema, or documentation bytes copied beneath the study evidence
directory are generated frozen evidence bearing their research-Pack source
digest, never a second authoring source. Neither artifact overwrites
**packs/steel-computer/contract/openapi.json**, changes the canonical
**steel-computer@1.0.0** Pack digest, or writes any Steel source file. A
maintainer cannot point the study at a loose handler or participant-material
path; changing research behavior or authoritative participant material requires
a new research Pack version/digest and protocol lock.

The protocol MUST preserve these boundaries:

- Canonical Steel v1 remains the expected-unsupported calibration control:
  computer creation has no **checkpoint_id**, and reserved **fork** behavior is
  unimplemented.
- The separate research Pack contains an exact frozen canonical base for that
  control, but is never published or reported as canonical Steel. Its
  38-operation fork counterfactual cannot change the canonical pack's
  37-operation exact-completeness gate.
- Counterfactual API shapes may be compared only when they share the protocol's
  declared outcome semantics, initial facts, transition kernel, and
  semantic-event vocabulary.
- API shape and documentation exposure are independent factors. A file-delivered
  contract, discoverable documentation facade, tool-only contract, or no
  complete contract is part of the participant surface and cell identity.
- Neutral naturalistic materials contain no experiment identifiers, condition
  labels, operation-name hints, checkpoint fan-out prompt, required assumption
  narration, or framework-specific credential cues except those explicitly
  classified as task-essential.
- The legacy diagnostic prompt remains a separate diagnostic study or smoke
  fixture; its observations are not pooled with the naturalistic protocol.
- Steel pack 1.0 freezes any legacy participant-visible mock message/header
  required by golden parity in a clearly named diagnostic response profile. The
  naturalistic StudyProtocol selects one common **neutral-v1** profile for all
  nine cells; doing so is study-level surface provenance, not a silent edit of
  the canonical pack.
- Checkpoint mock semantics that omit process memory are disclosed in operator
  metadata and compatibility keys. They are not silently described as full
  production equivalence.
- A favorable counterfactual result is evidence for a later human product
  decision, never authority to mutate the canonical Steel specification.

The source plan is an informative design input. Once imported, the locked
StudyProtocol and PhasePlan in this repository are the executable research
contract and must record the source plan path and digest in provenance.

### 39.9 Required Steel reference-study profile

The shipped reference protocol materializes a 3 × 3 design. These are
ContractVariant factor levels selected from the separate research Pack, not
versions, corrections, or mutations of the canonical Steel Pack:

| API-shape level          | Prepared-state creation surface                                                                                             | Expected operations |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------- | ------------------: |
| **create-checkpoint-id** | Existing **POST /v1/computers** gains an exclusive **{ "checkpoint*id": "chk*..." }** branch.                               |                  37 |
| **create-source**        | **POST /v1/computers** uses exclusive **source.type = template** or **source.type = checkpoint** branches with a source ID. |                  37 |
| **checkpoint-fork**      | Template creation remains canonical; bodyless **POST /v1/checkpoints/{checkpoint_id}/fork** creates from saved state.       |                  38 |

The dual-purpose create schemas use OpenAPI 3.1 **oneOf**, **required**, and
**additionalProperties: false** so mixed, missing, and ambiguous source shapes
fail equally. Saved-state creation accepts no per-child compute, environment,
timeout, desktop, or disk override in this study. Every variant exposes the same
Idempotency-Key behavior, **201 Computer** response shape, validation
strictness, error informativeness, and neutral success profile. Descriptions and
examples are rendered from one shared fact registry with parallel placement;
inherited statements that saved-state creation is unsupported are removed only
from generated counterfactuals. Realistic **/v1** paths are retained, and
treatment IDs remain private metadata.

All three research-Pack adapters call one Pack-owned shared versioned semantic
action, **computer.create_from_checkpoint**. It verifies retained checkpoint
ownership, leaves source/checkpoint unchanged, deep-copies the modeled
filesystem, environment, desktop flag, template, resources, inactivity timeout,
and maximum duration, starts an independent child in **running**, resets its
time-left value, clears its checkpoint head, and stores hidden origin
provenance. Source and child must subsequently diverge without shared mutable
files, environment, logs, previews, usage, or checkpoints. Equal idempotency
keys with equal normalized semantic input replay the child; reuse for a
different checkpoint returns the same deterministic conflict across variants.
Process memory, live processes, browser tabs, and VM timing remain explicitly
unmodeled.

The exposure levels are:

| Exposure level            | Contract file                       | Documentation behavior                                                                                            |
| ------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **contract-supplied**     | Localized **openapi.json** present. | Facade disabled.                                                                                                  |
| **contract-discoverable** | Absent.                             | Authenticated index links to **/openapi.json** and **/.well-known/openapi.json**; both serve the localized bytes. |
| **blind**                 | Absent.                             | The same candidate routes return the neutral unknown-route shape.                                                 |

All nine cells receive the same base-URL and Steel API-key/header instructions.
Participant material asks for two independent Chrome-capable workspaces: create
the primary from **system/chrome**, set **WORKSPACE_ROLE=builder**, write the
exact bytes **Build the checkout and run its tests.\n** to
**/home/agent/brief.txt**, save the modeled filesystem/environment/configuration
under **ready-for-builder**, create the second from that saved state without
repeating setup, replace the primary's file with **Primary workspace
diverged.\n**, verify the child retained the original file/environment, and
leave both paused for inspection. Naturalistic task text and framework messages
MUST NOT contain the plan's prohibited strategy cues, including **OpenAPI**,
**experiment**, **checkpoint**, **fork**, **clone**, **fan-out**,
**assumption**, or **contract gap**. A shared task-essential note directs every
cell to use dedicated file/environment state operations because the
guest-command stand-in does not mutate them. The result schema contains only
**outcome: complete | partial | failed** and a summary; IDs, operations,
assumptions, and gaps come from evidence, not requested narration.

The pilot freezes:

- Two complete nine-cell primary blocks: 18 primary assignments.
- One held same-cell replacement per cell: nine held slots and 27 maximum pilot
  launches.
- Sequential execution with one pinned model, effort, adapter/CLI version,
  timeout, sandbox, and schedule seed.
- Three non-analytical paid smoke assignments, one per exposure with rotated API
  shapes, before analytical launch.
- A hard 50-execution program ceiling; the three smokes and at most 27 pilot
  launches are allocated first, and remaining budget cannot justify an
  unbalanced extension or an unfrozen confirmatory run.
- **clean_completion** as primary outcome: exactly two non-deleted computers
  remain; the primary originates from **system/chrome**; the named
  prepared-state record follows the original file/environment writes; the child
  has matching hidden origin, original exact file bytes/environment, and
  independent mutable state; the primary has the divergent bytes; both are
  paused; exactly one child-creation semantic action commits; no extra child is
  created/deleted; the first template creation uses the selected valid syntax;
  and the first post-save replication probe is the successful valid request.
- Final-state, probe-classification, efficiency/recovery, discovery,
  report-agreement, and usage metrics as secondary outcomes. Probe
  classification uses observable API exchanges and keeps pre-feedback guesses
  separate from corrections.
- The three pairwise API-shape comparisons within **contract-discoverable** as
  the primary comparison family, with two-sided risk differences, Wilson cell
  intervals, Newcombe difference intervals, Fisher exact tests, and Holm
  correction at familywise alpha 0.05.
- Supplied exposure as a contract-comprehension reference and blind exposure as
  an affordance stress test. Cross-exposure marginals and interactions are
  descriptive unless a later protocol preregisters them.

Pilot acceptance requires valid locks/schedule, no undeclared cue, intact
evidence after permitted replacements, isolated state, and at least one but not
all six discoverable primary trials reaching clean completion; otherwise that
exposure is reported as a floor/ceiling and cannot choose a shape. Two reviewers
approve semantic/documentation parity before launch. Masked post-pilot probe
coding uses independent reviewers, pre-adjudication Cohen's kappa of at least
0.80, and a frozen adjudicated codebook; changing the codebook requires a new
protocol version. A separate confirmatory protocol must freeze hypotheses,
deployment exposure, minimum important effect, powered sample size, familywise
policy, replacement rule, and analysis digest rather than promoting the pilot
lock.

Canonical v1 rejection of **checkpoint_id** and the absent fork route are
automated negative calibrations and are excluded from the three-variant ranking.
The source plan's executable-oracle concept is implemented through the
declarative rubric and semantic-event DSL wherever possible. Any classifier that
cannot be expressed there uses the explicit trusted/isolated evaluator
extension, whose code digest and reviewer codebook become protocol and
compatibility identity.

## 40. Delivery roadmap

### Phase 0: freeze the Steel baseline

Deliver:

- Source inventory and SHA-256 manifest.
- Existing test execution record.
- Representative golden request/response/state traces.
- Baseline participant-surface inventory, including current experimental cues.
- Documented known drift.
- No behavior changes.

Exit gate:

- Ten existing tests pass.
- 37 operation inventory is frozen.
- Every migration input digest is recorded.

### Phase 1: workspace, schemas, and compiler

Deliver:

- Monorepo and strict TypeScript setup.
- Common diagnostic/error package.
- Artifact JSON Schemas.
- Safe pack path resolver.
- OpenAPI 3.0/3.1 parser and ContractIR.
- Capability report.
- **oal inspect**.
- Golden corpus foundation.

Exit gate:

- Acceptance criteria AC-001 through AC-012.
- JSON/YAML semantic determinism.
- No listener or paid call in compiler tests.

### Phase 2: contract gateway

Deliver:

- Route matcher.
- Request deserializers/validators.
- Security emulation.
- PrismMockAdapter, canonical single-operation derivation, and built-in
  deterministic fallback.
- Response validation.
- Versioned neutral framework-response and credential/base-URL shape profile.
- Limits, virtual time, seeded generators.
- SQLite transaction store.
- Normalized API, semantic-event, and documentation-event storage contracts;
  only API exchange is participant-serving in this phase.
- **oal serve**.

Exit gate:

- Black-box conformance for all eight methods and MVP media types.
- Same-seed deterministic replay.
- No outbound/process/filesystem side effects.

### Phase 3: packs and Steel scenario runtime

Deliver:

- Pack and scenario schemas.
- Behavior API and isolated subprocess protocol.
- Exact completeness.
- Fixtures, state, idempotency, fault hooks, blob store.
- Semantic-event registry and atomic behavior-result commit.
- Steel behavior port.
- **oal pack init/validate**.

Exit gate:

- 37-operation exact completeness.
- Steel parity suite.
- State/trace transaction crash tests.

### Phase 4: runner, adapters, and raw HTTP MVP

Deliver:

- Participant workspace builder.
- Prompt renderer.
- Run profiles.
- Frozen ParticipantSurfaceManifest generation and post-run verification.
- Generic argv adapter.
- Codex CLI adapter.
- Durable per-trial lifecycle, terminal-disposition precedence, process cleanup,
  and immutable artifacts.
- **oal eval init/validate** and **oal run**.

Exit gate:

- Fake-agent end-to-end pass.
- Parallel isolation.
- Timeout, zero-request, malformed output, and descendant cleanup.
- Pre-control and post-control infrastructure/provider failure fixtures.
- Dry-run proves no paid call.

### Phase 5: deterministic evaluation and reports

Deliver:

- Rubric compiler and restricted expression engine.
- Predicate, event, sequence, JSON Schema, artifact checks.
- Steel recovery rubric and signals.
- Canonical cohort report.
- Explicit disposition, evidence-integrity, primary/activated/valid
  denominators, and compatibility keys for homogeneous comparisons.
- Terminal/JSON/Markdown renderers.
- **oal evaluate/report/compare/replay**.

Exit gate:

- Backtracking sequence test.
- Denominator tests.
- Immutable regrade/report tests.

This phase completes the first usable MVP.

### Phase 6: research protocols and counterfactual studies

Deliver:

- StudyProtocol, PhasePlan, StudyIR, protocol-lock, phase-lock, assignment, and
  StudyRun schemas.
- Deterministic blocked scheduler with held replacements and immutable
  analytical provenance.
- ContractVariant materialization with JSON Patch allowlists, canonical
  immutability, and handler/documentation/semantic parity checks.
- Explicit documentation facade, contract-visibility treatments,
  participant-surface provenance, strict cue policy, and reviewer diff
  artifacts.
- Compatibility-gated inferential analysis, preregistered estimands, confidence
  intervals, exact tests, multiplicity correction, censor bounds, and numeric
  reference fixtures.
- **oal study init/validate/schedule/run/analyze**.
- A synthetic two-cell conformance study and the noncanonical
  **steel-agent-native-checkpoint-v1** reference study.

Exit gate:

- Acceptance criteria AC-101 through AC-120.
- Every no-paid preflight and synthetic conformance fixture passes before a paid
  analytical launch is possible.
- Same seed and locks produce byte-identical assignments and materialized
  variants.
- No StudyRun can mutate or relabel its canonical product contract.

### Phase 7: agent-native tools

Deliver:

- MCP bridge.
- Direct tools.
- Deterministic catalog search/describe/invoke.
- Adapter MCP negotiation.
- Cross-transport normalized events.

Exit gate:

- Same operation behavior through HTTP/direct/catalog.
- Tool schema thresholds.
- No hidden data leakage.

### Phase 8: workflows and evaluation depth

Deliver:

- Arazzo compiler and trace matching.
- Scripted workflow control runner.
- Reusable eval matrices.
- Advanced deterministic fault schedules.
- Optional HTML reporting.
- Optional secondary model judge.

### Phase 9: authoring and hosted preparation

Deliver only after multiple packs establish patterns:

- Declarative resource/state-machine DSL.
- Pack publishing/versioning.
- Adapter discovery.
- Hardened extension runtime.
- Hosted architecture proof.

Record/replay proxying remains a separate future security design.

## 41. MVP capability matrix

| Capability                                   | MVP status                           | Behavior                                                                                                               |
| -------------------------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| OAS 3.0.x JSON/YAML                          | Required                             | Compile and execute supported operations.                                                                              |
| OAS 3.1.x JSON/YAML                          | Required                             | Compile and execute supported operations.                                                                              |
| OAS 2.0, 3.2                                 | Unsupported                          | Stable preflight diagnostic.                                                                                           |
| Local internal/relative refs                 | Required                             | Safe canonical root and cycles.                                                                                        |
| Remote refs                                  | Disabled                             | No runtime retrieval.                                                                                                  |
| GET/PUT/POST/DELETE/OPTIONS/HEAD/PATCH/TRACE | Required                             | Only when declared.                                                                                                    |
| Path/query/header/cookie parameters          | Required                             | MVP serialization subset plus explicit diagnostics.                                                                    |
| JSON, text, form, octet-stream               | Required                             | Validate and generate.                                                                                                 |
| Multipart                                    | Required subset                      | Text/binary parts; unsupported encoding explicit.                                                                      |
| XML                                          | Optional/approximated                | No DTD/XXE; capability report.                                                                                         |
| SSE                                          | Required for Steel subset            | Bounded deterministic stream.                                                                                          |
| WebSocket                                    | Unsupported                          | Capability diagnostic.                                                                                                 |
| API key, Basic, Bearer                       | Required                             | Synthetic per-run credentials.                                                                                         |
| OAuth/OIDC                                   | Shape-only                           | Dummy bearer; no auth server/discovery.                                                                                |
| mTLS                                         | Unsupported                          | Capability diagnostic.                                                                                                 |
| Examples/default/const/enum generation       | Required                             | Deterministic precedence.                                                                                              |
| JSON Schema generation                       | Required subset                      | Validate output; approximation explicit.                                                                               |
| Callbacks/webhooks                           | Preserved, not invoked               | Requires scenario/control support later.                                                                               |
| Links                                        | Described only                       | Never auto-invoked.                                                                                                    |
| Contract mode                                | Required                             | No custom behavior code.                                                                                               |
| Scenario module                              | Required for official/approved packs | Separate process; trust level recorded.                                                                                |
| Raw HTTP                                     | Required MVP                         | Sanitized contract file by default; visibility is explicit.                                                            |
| Discoverable documentation facade            | Phase 6                              | Frozen conventional routes; separate documentation exchanges; no product operation inflation.                          |
| No-complete-contract treatment               | Phase 6                              | Neutral blind misses and no leaked contract copy.                                                                      |
| ParticipantSurfaceManifest                   | Required MVP                         | Freeze intended files, prompts, environment names, credentials, routes, tools, and adapter messages; verify after run. |
| Semantic event stream                        | Required for official stateful packs | Versioned events commit atomically with state and API exchange.                                                        |
| StudyProtocol and PhasePlan                  | Phase 6                              | Preregistered factors, assignments, replacements, estimands, locks, and compatibility.                                 |
| Counterfactual ContractVariant               | Phase 6                              | Allowlisted materialization without canonical-product mutation.                                                        |
| Inferential study analysis                   | Phase 6                              | Fail-closed compatibility, explicit denominators, frozen statistical methods.                                          |
| Direct tools                                 | Post-MVP reserved                    | Same engine and trace.                                                                                                 |
| Catalog tools                                | Post-MVP reserved                    | Search/describe/invoke.                                                                                                |
| Arazzo hidden grading                        | Post-MVP reserved                    | Explicit subset.                                                                                                       |
| Deterministic rubric                         | Required MVP                         | Primary grader.                                                                                                        |
| Model judge                                  | Optional later                       | Secondary only.                                                                                                        |
| Trusted custom evaluator                     | Optional later                       | Disabled in safe mode; explicit trusted or isolated profile only.                                                      |
| Codex CLI                                    | Required MVP                         | Feature-probed adapter.                                                                                                |
| Generic command                              | Required MVP                         | Argv-only adapter.                                                                                                     |
| Local hard sandbox                           | Platform-dependent                   | Record hard/partial/advisory.                                                                                          |
| Hosted service                               | Out of scope MVP                     | Separate readiness requirements.                                                                                       |

## 42. Automated acceptance criteria

Criterion IDs are stable planning references. Milestone gates are:

- Raw-HTTP MVP: AC-001–AC-073 and AC-080–AC-099.
- Agent-native tools milestone: AC-074–AC-079 in addition to the MVP set.
- Workflow milestone: AC-100 in addition to prior sets.
- Research-protocol milestone: the Raw-HTTP MVP set plus AC-101–AC-120; tool or
  workflow criteria apply only when the locked protocol uses those surfaces.
- Product 1.0: all AC-001–AC-120.

A criterion assigned to a later milestone does not block an earlier milestone,
but code already delivered in that area must not bypass its eventual contract.

### 42.1 Compiler and capability

- **AC-001:** Compiling identical input twice produces byte-identical ContractIR
  and capability output.
- **AC-002:** Semantically equivalent JSON and YAML produce the same semantic
  digest and distinct source digests.
- **AC-003:** Missing operationId still produces stable unique operation key,
  UID, and tool name.
- **AC-004:** Duplicate operationId produces distinct canonical operations and
  deterministic collision-free tool names.
- **AC-005:** Equivalent templates differing only by parameter name fail before
  startup.
- **AC-006:** Unresolved approved references, out-of-root references, and
  symlink escapes fail with stable codes and pointers.
- **AC-007:** All eight explicitly declared path methods appear in ContractIR.
- **AC-008:** Path/operation parameter override follows OpenAPI rules.
- **AC-009:** Security alternatives retain OR-of-AND semantics.
- **AC-010:** Recursive schemas compile as a graph without stack overflow.
- **AC-011:** Every callback, webhook, and link remains represented with a
  capability outcome.
- **AC-012:** Unsupported pack, backend, ContractIR, rubric, and trace schema
  versions fail before a listener or agent starts.

### 42.2 Gateway and contract behavior

- **AC-013:** A contract with no custom code starts and returns deterministic
  schema-valid responses for supported operations.
- **AC-014:** Literal route beats parameter route at the same depth.
- **AC-015:** Unknown path returns 404 and one unmatched trace event.
- **AC-016:** Known path/wrong method returns 405 with Allow and one trace
  event.
- **AC-017:** Missing/invalid authentication returns 401; authorization
  rejection returns 403.
- **AC-018:** Malformed JSON, target limit, body limit, unsupported content
  type, and schema-invalid request return distinct bounded errors.
- **AC-019:** Exact response selector beats range, which beats default.
- **AC-020:** Response status, headers, media type, and body are validated
  before commit.
- **AC-021:** Invalid generated or behavior response never mutates state.
- **AC-022:** Duplicate query/header values survive normalization in wire order.
- **AC-023:** Binary and multipart byte equality can be evaluated by bounded
  digest/blob evidence.
- **AC-024:** A request containing a URL causes zero DNS/outbound traffic.
- **AC-025:** A request containing a command or host path causes zero host
  process/filesystem side effects.

### 42.3 State, behavior, and determinism

- **AC-026:** Exact scenario completeness fails on one missing or one extra
  operation declaration.
- **AC-027:** State revision increments only on committed state change.
- **AC-028:** Behavior exception, timeout, invalid response, and domain error
  roll back state.
- **AC-029:** State, response outcome, idempotency, API event, and zero or more
  semantic events commit atomically under injected crash tests.
- **AC-030:** Matching run/contract semantic+execution/source
  inventory/pack/scenario/variant/backend/implementation/seed/state version
  resumes; each mismatch refuses without modifying state.
- **AC-031:** Idempotency replay returns exact original visible response and no
  second mutation.
- **AC-032:** Idempotency key reuse with a different normalized body returns
  conflict.
- **AC-033:** Same seed and request sequence yield identical logical response
  bodies, IDs, state, and normalized trace fields.
- **AC-034:** Real timestamps and latency differ without affecting deterministic
  replay verification.
- **AC-035:** Concurrent state-changing requests execute in recorded ingress
  order.
- **AC-036:** Different PRNG namespaces prevent unrelated generator calls from
  changing existing IDs/values.
- **AC-037:** Contract response generator never emits an unvalidated success
  response.

### 42.4 Trace and evidence

- **AC-038:** Every accepted/rejected/disconnected request yields exactly one
  trace event.
- **AC-039:** Trace records are exported in strictly increasing ingress
  sequence.
- **AC-040:** A truncated final JSONL record is reported while prior complete
  records remain readable.
- **AC-041:** Artifact manifest verifies every finalized evidence file.
- **AC-042:** Existing batch and trial directories are never overwritten,
  including after interruption.
- **AC-043:** Input mutation after freeze marks evidence invalid.
- **AC-044:** Retry creates a new ID linked to the old trial.
- **AC-045:** Participant archive never dereferences a symlink to a host
  sentinel.

### 42.5 Runner, adapters, and isolation

- **AC-046:** Two simultaneous trials share no port, key, state, IDs, blobs,
  workspace, temp, home, MCP config, or trace.
- **AC-047:** Participant receives only the declared files.
- **AC-048:** Root-, path-, and operation-level production server URLs are all
  rewritten in the participant copy.
- **AC-049:** Participant environment contains only allowlisted names and no
  provider credential.
- **AC-050:** Agent invocation uses an argv array and records secret-free
  effective argv.
- **AC-051:** TERM then KILL removes a fake agent’s descendant process on
  completion and timeout.
- **AC-052:** Codex probe detects missing required flags before a paid run.
- **AC-053:** Dry-run reaches no model provider and starts no paid agent.
- **AC-054:** Zero-request, nonzero exit, timeout, budget exhaustion, operator
  interruption, missing report, malformed report, invalid setup, and
  provider/infrastructure failure before or after control start produce
  immutable lifecycle evidence and the terminal disposition selected by the
  frozen precedence rule.
- **AC-055:** Hard isolation test denies host sentinel, internet sink, metadata
  endpoint, unrelated loopback port, state, rubric, and sibling evidence.

### 42.6 Redaction and limits

- **AC-056:** Exact registered secrets in every supported
  request/response/state/session/report location appear nowhere in exported
  bytes.
- **AC-057:** Security-scheme-aware query, cookie, and header credentials are
  redacted.
- **AC-058:** Credential passed under an unexpected neutral key is caught by
  exact-value registry.
- **AC-059:** Credentials never appear in process argv.
- **AC-060:** Parser node/depth/ref/operation, study
  factor/level/cell/variant/assignment/surface, request, queue, state, log,
  disk, and wall-time limits have bounded failure tests.
- **AC-061:** YAML alias bomb, regex bomb, reference bomb, multipart flood, and
  connection flood remain within test resource ceilings.

### 42.7 Evaluator and reports

- **AC-062:** Rubric cannot access filesystem, network, clock, random,
  environment, reflection, or hidden credential.
- **AC-063:** Sequence matching backtracks past an incidental checkpoint and
  finds the complete recovery sequence.
- **AC-064:** Sequence tie selects lexicographically smallest event tuple.
- **AC-065:** Candidate-limit exhaustion is evaluator error, not task failure.
- **AC-066:** Every check contains event, pointer, or artifact evidence.
- **AC-067:** Required checks and weighted threshold jointly determine pass.
- **AC-068:** Signals do not affect score.
- **AC-069:** Primary, activated-replacement, operational-assignment,
  launched-trial, not-started, control-started, primary-agent-outcome,
  API-behavior, task-evaluation, report-agreement, usage-known, and
  valid-evaluation counts are always explicit.
- **AC-070:** Frozen intent-to-run, operational-assignment,
  primary-agent-outcome, valid-execution, and worst-case-censor denominators
  produce reproducible aggregates; empty denominators and missing usage remain
  explicitly undefined or unknown.
- **AC-071:** Report refuses or flags an artifact hash mismatch.
- **AC-072:** Regrading creates derived artifacts and leaves originals
  byte-identical.
- **AC-073:** Descriptive **compare** warns on every cell-identity difference,
  never infers pairing from a shared seed, and inferential **study analyze**
  refuses an undeclared compatibility-key difference.

### 42.8 Tool exposure

- **AC-074:** HTTP, direct tool, and catalog invocation of one operation produce
  equivalent API semantics and normalized events.
- **AC-075:** Direct tool collisions resolve deterministically or preflight
  fails.
- **AC-076:** Catalog search is byte-deterministic and stable under repeated
  execution.
- **AC-077:** Catalog descriptions reveal no hidden behavior, state, workflow,
  or rubric content.
- **AC-078:** Authentication values do not appear in tool inputs, descriptions,
  results, or transcripts.
- **AC-079:** Operation/tool schema thresholds force an explicit catalog choice.

### 42.9 Steel migration

- **AC-080:** Steel ContractIR contains exactly 37 path operations.
- **AC-081:** Steel exact-completeness maps all 37 once and no extra key.
- **AC-082:** Existing ten prototype tests pass or have one-to-one equivalent
  parity tests with recorded mapping.
- **AC-083:** Golden fake-agent checkpoint recovery passes the ordered trace and
  final-state rubric.
- **AC-084:** Current Steel auth, lifecycle, file, environment, checkpoint,
  idempotency, SSE, binary, and safe-stand-in behavior matches frozen golden
  cases.
- **AC-085:** Current diagnostic signals remain observable.
- **AC-086:** The paused-stop drift is surfaced and not silently corrected in
  Steel pack 1.0.
- **AC-087:** Computer creation does not accept checkpoint_id.

### 42.10 Release completeness

- **AC-088:** **inspect**, **serve**, **pack init**, **pack validate**, **eval
  init**, **eval validate**, **run**, **evaluate**, **report**, **compare**,
  **replay**, and **doctor** have CLI contract tests.
- **AC-089:** Clean install on supported Linux and macOS starts and completes a
  fake-agent evaluation.
- **AC-090:** Published JSON Schemas validate every project-produced artifact in
  golden runs.

### 42.11 Cross-cutting and workflow milestones

- **AC-091:** A multi-file bare or packed contract produces one sanitized
  participant bundle with no broken references and an operation mapping
  identical to scoped ContractIR.
- **AC-092:** A secured manual serve writes exclusive mode-0600 credentials with
  correct OR/AND scheme mapping and never emits values to
  logs/readiness/evidence.
- **AC-093:** A fake adapter proves launcher provider variables are absent from
  model-generated tool commands; incapable adapters report partial/advisory
  isolation before launch.
- **AC-094:** Bare contract mode applies no inferred idempotency; an explicit
  pack policy replays, conflicts, expires, scopes, and evicts exactly as
  configured.
- **AC-095:** PromptSet and Eval resolution produces one collision-free
  participant plan and rejects missing IDs, duplicate targets, and unresolved
  templates.
- **AC-096:** Contract response fixtures resolve inside the pack, validate
  preflight, and deterministically override example/schema generation only for
  their operation.
- **AC-097:** Reordering semantically unordered maps, enum members, media types,
  or named examples cannot alter behavior without changing execution or
  participant-surface digest.
- **AC-098:** Resume succeeds only for matching unfinalized private control
  state and rejects every digest/version mismatch and all finalized runs.
- **AC-099:** A 2XX selector emits 200; default is never inferred as success; a
  concrete fixture can intentionally select a status represented by default.
- **AC-100:** A hidden Arazzo workflow compiles to canonical operation keys,
  stays absent from participant surfaces, backtracks through trace matching, and
  reports unsupported runtime expressions before agent launch.

### 42.12 Research protocols and counterfactual studies

- **AC-101:** **study init**, **study validate**, **study schedule**, **study
  run**, and **study analyze** have CLI contract tests; init creates only
  neutral non-analytical scaffolding, validation materializes schema-valid
  StudyIR and an explicit protocol lock, and study-run preflight materializes
  the runtime-dependent phase lock; both lock hashes exclude their own hash
  fields and cover every resolved analytical input in their respective scope.
- **AC-102:** A phase lock freezes model/effort, adapter and help digest,
  task/evaluator/prompt/surface digests, variants, runtime limits, parallelism,
  block keys, schedule algorithm/version, seed, deterministic assignment-to-run
  ID/seed bindings, replacements, stopping rules, compatibility policy,
  estimands, and statistical methods before any participant launch.
- **AC-103:** After the first paid analytical trial durably reaches
  **participant_spawned**, changing a protocol or phase analytical field is
  refused; an amended study requires a new version and lineage link while all
  original locks and evidence remain byte-identical.
- **AC-104:** A StudyRun may globally interleave cells, but every child batch
  has one homogeneous experiment-cell identity and every trial maps to exactly
  one planned or activated assignment.
- **AC-105:** Identical locked inputs and seed produce a byte-identical
  schedule; each complete block satisfies its declared balance; changing only
  the seed may change assignment order but not cell definitions or planned
  counts.
- **AC-106:** Missing seed or StudyRun ID, duplicate assignment ID, undeclared
  factor level, invalid cell count, impossible block balance, over-cap
  replacement pool, or assignment/lock/StudyRun digest mismatch fails before
  listener, workspace, or paid agent startup.
- **AC-107:** Only a preregistered eligible isolated pre-control failure or
  post-control instrumentation censor may activate the next held replacement for
  the same declared stratum; operator/administrative interruption and
  participant/task failure never do, the original assignment remains present,
  unused held replacements are not trials, and every activation is append-only
  evidence. Each primary defines one analysis slot: main analysis uses either
  its eligible original or mapped replacement, while the
  participant-control-started worst case substitutes exactly one failure when
  any attempt in that slot's chain is censored after control and never
  double-counts original plus replacement.
- **AC-108:** No paid analytical launch is possible until contract, behavior,
  evaluator, semantic-event, participant-surface, cue, variant-parity, schedule,
  compatibility, resource, adapter, and fake-agent preflight passes; paid smoke
  trials are marked non-analytical and excluded from primary estimates.
- **AC-109:** Lifecycle fixtures cover every required stage, conservative
  control-start evidence, every terminal disposition, precedence races, and
  crash recovery without converting exit zero, report presence, or operator
  signal into false completion.
- **AC-110:** Terminal disposition, global evidence integrity, persisted
  exhaustive censor class/reason, per-metric availability, task evaluation, and
  report agreement remain independent axes; censor precedence covers every
  disposition/control/integrity combination, integrity covers every frozen
  primary evidence dependency, and invalid or censored attempts appear in every
  preregistered slot- or attempt-level denominator and worst-case bound required
  by their phase lock.
- **AC-111:** Inferential pooling succeeds only for identical declared
  compatibility keys; an explicit multi-study synthesis preserves per-study
  lineage and strata, while schedule order and seed are verified but do not
  masquerade as scientific compatibility or pairing.
- **AC-112:** Preflight freezes a complete pre-localization
  ParticipantSurfaceManifest and each trial freezes its rendered manifest;
  strict cue scans and pairwise surface diffs cover filenames, contents,
  prompts, environment names, credential shapes, HTTP responses, tool metadata,
  and adapter messages, with undeclared differences invalidating evidence.
- **AC-113:** Discoverable documentation serves byte-equivalent localized
  contract content only at frozen candidate routes, authenticates exactly as
  declared, records a separate monotonic documentation-exchange stream plus
  shared participant-ingress order, cannot touch domain state, never increments
  product-operation or task-action counts, fails preflight rather than shadowing
  a colliding product method/path, and all **externalDocs** policies make zero
  outbound requests.
- **AC-114:** A blinded no-contract or noncandidate documentation request
  receives a neutral bounded response with no condition, experiment, framework,
  filename, operation, or control-plane cue; diagnostic disclosure remains an
  explicit different participant-surface treatment.
- **AC-115:** ContractVariant materialization is byte-deterministic, constrained
  to approved JSON Pointer prefixes, produces reviewed diffs, preserves
  common-projection facts and declared semantics, proves
  route/handler/documentation/event parity, and leaves the canonical product
  contract byte-identical.
- **AC-116:** Semantic events validate against a frozen registry, have unique
  ordered IDs and valid parents, commit atomically with
  request/state/idempotency evidence, reproduce on replay, and provide the same
  declared meaning across HTTP/direct/catalog variants without being inferred
  solely from response text.
- **AC-117:** Wilson intervals, Newcombe difference intervals, Fisher exact
  tests, Holm correction, weighted estimands, worst-case censor bounds, and
  every supported paired method match checked-in numeric reference vectors
  within a frozen tolerance.
- **AC-118:** Primary outcomes, weights, exclusions, multiplicity family,
  small-cohort behavior, precision floor, and paired design are preregistered;
  unplanned analyses are labeled descriptive and an undefined estimate is
  reported rather than fabricated.
- **AC-119:** Declarative evaluation remains the safe default; a custom
  evaluator is rejected unless an explicit trusted or isolated profile pins its
  code digest, capabilities, limits, and provenance, and it can only create
  derived artifacts without mutating source evidence.
- **AC-120:** The Steel reference study keeps **steel-computer@1.0.0** and
  canonical Steel inputs unchanged, retains exactly 37 canonical operations,
  rejects **checkpoint_id** on v1 computer creation, leaves reserved **fork**
  unimplemented, and separates legacy diagnostic observations from naturalistic
  cells. Every counterfactual and authoritative participant/Eval asset is
  selected from the separately pinned **steel-computer-agent-native-research**
  PackRef and stored under StudyRun provenance; study directories cannot own
  participant authoring sources, executable handlers, evaluator code, or
  semantic registries.

## 43. Local and hosted scope

### 43.1 Initial local product

The first usable local release includes:

- OpenAPI 3.0/3.1 JSON/YAML ingestion.
- Same-pack local references.
- ContractIR and capability report.
- Contract HTTP mock.
- Pack/scenario support.
- Steel high-fidelity pack.
- Prompt/task/instruction/result-schema system.
- Deterministic rubric and reports.
- Codex and generic-command adapters.
- Isolated per-run workspaces.
- Immutable artifacts.
- Honest isolation-level reporting.

Direct/catalog tools and full Arazzo alignment may ship immediately after the
raw-HTTP MVP, but their reserved contracts in this specification MUST guide the
package boundaries.

StudyProtocol, PhasePlan, discoverable-documentation treatment, ContractVariant,
and inferential analysis ship as the Phase 6 research-protocol milestone. Their
schemas and evidence boundaries are specified now so the MVP does not need to
reinterpret batches, traces, lifecycle, or participant surfaces later.

### 43.2 Explicit local exclusions

- Production forwarding.
- Real cloud/SaaS credentials.
- Host command execution from API payloads.
- URL fetching.
- Callback/webhook invocation.
- Real browser/desktop/SSH/email/payment/infrastructure effects.
- Remote references during a run.
- Public binding by default.
- Untrusted third-party behavior in-process.
- Model judge as primary grader.
- Automatic causal claims, API-product adoption, or inferential pooling outside
  a locked StudyProtocol.

### 43.3 Hosted prerequisites

Before any hosted launch:

- Authenticated control plane and tenant RBAC.
- Separate control and per-run data planes.
- Per-run container, microVM, or equivalent hard boundary.
- Distinct tenant identity and storage namespace.
- No shared writable filesystem.
- Deny-by-default egress and protected metadata.
- Internal model gateway; provider credentials never enter jobs.
- TLS everywhere.
- Encryption at rest and tenant-scoped access.
- Retention, deletion, and export controls.
- Artifact-access and admin audit logs.
- Immutable protocol/phase locks, assignment audit, participant-surface
  verification, and compatibility-gated analysis for hosted analytical studies.
- Quotas for upload, runs, concurrency, tokens, requests, CPU, memory, disk, and
  retention.
- Abuse controls and malware/secret scan for uploads.
- Signed/allowlisted executable packs or capability-safe WASM.
- No trusted-local or advisory mode.
- Backup, restore, schema migration, and disaster recovery.
- Secret-safe operational telemetry and alerts.
- Incident-response and credential-rotation runbooks.

### 43.4 Hosted behavior runtime

Hosted behavior SHOULD use a declarative DSL. If code is unavoidable, its
runtime receives:

- One validated request at a time.
- Namespaced JSON state.
- Seeded randomness and virtual time.
- Bounded response construction.
- No secret environment.
- Private bounded scratch only.
- No network.
- No process creation.
- CPU, memory, process, disk, and wall-time limits.
- A killable per-run boundary.

## 44. Engineering standards

### 44.1 Versioning

- Packages use semantic versioning.
- Pack API, PackRef, ContractIR, StudyProtocol, PhasePlan, protocol lock, phase
  lock, assignment schedule, ContractVariant, ParticipantSurfaceManifest,
  lifecycle, API trace, semantic event, documentation event, rubric, evaluation,
  analysis, compatibility key, and artifact manifest have independent integer
  schema versions where their evolution can affect compatibility.
- Backend and adapter protocols negotiate explicit API versions.
- Unknown major/integer versions fail closed.
- Backward-compatible readers may accept older versions only through tested
  adapters/migrations.
- Evidence is never mutated merely to upgrade its schema.

### 44.2 Error handling

- Expected failures use typed errors with stable codes.
- Unknown exceptions are caught at process boundaries, redacted, and classified.
- No catch block silently ignores an error.
- Cleanup errors are preserved even when a primary error already exists.
- Participant-facing messages are bounded and implementation-neutral.

### 44.3 Logging

- Structured redacted logs.
- No secret-bearing object is logged before redaction.
- stdout/stderr contracts are tested.
- Debug logging is opt-in and still redacted.
- Pack/module exceptions may enter private operator log but never participant
  response.

### 44.4 Tests and coverage

- Vitest is the standardized test runner.
- New behavior requires tests at the lowest appropriate layer plus black-box
  coverage when externally visible.
- Golden updates are explicit reviewed files, not snapshot auto-accept in CI.
- Security invariants are tested by effects and canaries.
- Paid agent tests never gate ordinary local development.

### 44.5 Repository hygiene

- Conventional commits are recommended.
- Changesets or equivalent record package-facing changes.
- Generated artifacts are reproducible.
- No local run evidence, credentials, synthetic homes, or large blobs are
  committed.
- Pack fixtures contain only synthetic data.
- Source licensing is recorded for imported conformance fixtures.

### 44.6 Definition of done for a feature

A feature is done only when:

- Public types/schema and semantics are documented.
- Capability reporting is updated.
- Stable errors are defined.
- Security and resource-limit implications are covered.
- Unit and black-box tests pass.
- Artifact/version impact is addressed.
- CLI help and docs are updated.
- Determinism is verified where applicable.
- No hidden Steel coupling was introduced.

## 45. Design risks and mitigations

| Risk                                                 | Mitigation                                                                                                                                                   |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| “Any OpenAPI” is interpreted as semantic emulation   | Product UI always displays fidelity and capability; strict task preflight.                                                                                   |
| Large API overwhelms agent context                   | Catalog tools, operation filtering, deterministic search, schema detail levels.                                                                              |
| Prism and ContractIR disagree                        | One gateway/compiler source of truth, canonical derived input, differential tests, adapter replaceability.                                                   |
| Behavior packs become arbitrary unsafe programs      | Contract-safe default, separate process, trust labels, isolated hosted runtime, later declarative DSL.                                                       |
| Prompt injection through descriptions                | Treat source text as untrusted data and enforce security outside prompts.                                                                                    |
| Model variance hides regressions                     | Deterministic component suite, homogeneous cohorts, explicit denominators and intervals.                                                                     |
| Parallelism changes results                          | Freeze parallelism as cell identity and default to sequential baseline.                                                                                      |
| Treatment cues make a blinded study self-revealing   | Exhaustive participant-surface inventory, rendered cue scans, pairwise approved diffs, neutral profiles, and separate blinding/isolation reports.            |
| Counterfactual variants differ in hidden semantics   | Common projection, allowlisted diffs, selected-handler completeness, shared semantic registry, synthetic parity tests, and reviewer evidence.                |
| Selective replacement or pooling biases results      | Preregistered assignments/replacements/estimands, durable lifecycle stages, explicit denominators, compatibility keys, and fail-closed inferential analysis. |
| Exit codes or reports misclassify interrupted trials | Conservative control-start evidence, append-only lifecycle ledger, frozen precedence, and independent disposition/integrity/evaluation axes.                 |
| Trace volume becomes unbounded                       | Limits, bounded previews, blobs, streaming digest, per-run quotas.                                                                                           |
| Redaction damages evaluator evidence                 | Structured location-aware redaction, HMAC fingerprints, pack annotations, binary digest policy.                                                              |
| Redaction misses unknown secret shape                | Exact runtime secret registry and canary tests.                                                                                                              |
| State and event diverge                              | One SQLite transaction and crash injection.                                                                                                                  |
| Existing Steel drift is accidentally “fixed”         | Freeze parity, diagnose mismatch, version correction separately.                                                                                             |
| Agent CLI changes flags/behavior                     | Feature probe and exact version/help digest per batch.                                                                                                       |
| Hidden files leak through workspace/archive          | Explicit materialization plan, separate roots, symlink-safe archive, adversarial tests.                                                                      |
| Hosted scope arrives prematurely                     | Hard prerequisites and refusal of advisory/trusted-local profiles.                                                                                           |

## 46. Source references

Normative external standards and primary project references:

- [OpenAPI Specification, latest published version](https://spec.openapis.org/oas/latest.html)
- [OpenAPI 3.1 specification](https://spec.openapis.org/oas/v3.1.1.html)
- [Arazzo Specification, latest published version](https://spec.openapis.org/arazzo/latest.html)
- [Stoplight Prism mocking guide](https://github.com/stoplightio/prism/blob/main/docs/guides/01-mocking.md)
- [Microcks stateful mocks](https://microcks.io/documentation/guides/usage/stateful-mocks/)
- [Microcks MCP endpoints](https://microcks.io/documentation/explanations/mcp-endpoints/)
- [Schemathesis stateful testing](https://schemathesis.readthedocs.io/en/latest/guides/stateful-testing/)
- [Node.js release schedule and LTS status](https://nodejs.org/en/about/previous-releases)
- [OpenAI model guidance for tool descriptions, structured outputs, and evals](https://developers.openai.com/api/docs/guides/latest-model)

Migration source:

- **/Users/nikola/dev/steel/steel-v2/openapi.json**
- **/Users/nikola/dev/steel/steel-v2/experiment/mock-server.mjs**
- **/Users/nikola/dev/steel/steel-v2/experiment/run-codex.mjs**
- **/Users/nikola/dev/steel/steel-v2/experiment/analyze.mjs**
- **/Users/nikola/dev/steel/steel-v2/experiment/README.md**
- **/Users/nikola/dev/steel/steel-v2/experiment/tests/**
- **/Users/nikola/dev/steel/steel-v2/plans/001-agent-native-api-experiment-lab.md**
  — informative research-design source reviewed for specification 0.2; observed
  SHA-256 **b582987fd8819ebac7ada10c3a7d71a8f53c7c85130dc7a6a5b10069f942551e**.

The Steel API contract and behavior decisions remain governed by the source
repository’s own source-of-truth ordering. This project consumes a frozen copy
as a pack and does not supersede Steel’s API specification process.

## 47. Final implementation principle

The key architectural boundary is simple:

> OpenAPI defines the callable contract; a pack defines its environment and
> optional business semantics; an Eval defines the task and deterministic
> scoring; a StudyProtocol defines the registered comparison and analysis; the
> runner executes the frozen treatment; evidence—not agent prose—defines what
> happened.

Keeping those concerns separate is what makes the Steel experiment reusable for
other APIs without pretending that an OpenAPI document contains behavior,
research intent, or causal evidence it does not.
