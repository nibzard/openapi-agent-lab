# Using the local product

This document walks through the local product concept by concept. Each
section names the command or artifact that demonstrates the concept. Read
[the quickstart](quickstart.md) first for a full end-to-end run.

The local product covers the initial release scope:

- OpenAPI 3.0 and 3.1 ingestion, in JavaScript Object Notation (JSON) or
  YAML.
- A compiled contract and a capability report.
- A deterministic contract mock with pack-supplied response fixtures.
- Prompts, tasks, instructions, and result schemas.
- Deterministic rubrics, evaluations, and reports.
- Adapters for the mock agent, the Codex CLI, and generic commands.
- Isolated per-run workspaces and immutable artifacts.
- Honest reporting of the isolation level that was actually reached.

Stateful scenario serving is not part of this build. `oal serve --mode
scenario` and `oal run --exposure direct-tools|catalog-tools` refuse with
exit code `4`. See the [review fix plan](review-fix-plan.md) for the work
that connects those paths.

## Ingestion and the capability report

Every command accepts a **source** argument. A source is either a local
OpenAPI document or a pack directory that contains `pack.yaml`. Remote URLs
are never fetched.

Ingestion parses the document, resolves same-document and same-pack
references, and reports what it found. The `@oal/openapi` package owns this
stage. Use `oal inspect` to see the report:

```sh
oal inspect examples/quickstart.json
oal inspect packs/steel-computer
```

The report covers the OpenAPI version, digests, the operation count, and
per-operation diagnostics. It names missing or duplicate operation IDs and
generated tool names. It counts operations as supported, approximated,
requires-scenario, or unsupported. It also recommends an exposure mode and
states whether contract mode, direct tools, and catalog tools are viable.

In strict mode, inspection fails when an operation is not fully supported:

```sh
oal inspect examples/quickstart.json --strict
```

## ContractIR

The contract intermediate representation (ContractIR) is the immutable,
normalized form of the parsed contract. The compiler in `@oal/openapi`
produces it. Every later stage reads the ContractIR, never the original
bytes.

You rarely read the ContractIR by hand. It appears as a frozen input in every
batch:

```text
.oal/runs/<batch-id>/inputs/contract.ir.json
```

Two runs over the same document and the same pack produce the same
`contract.ir.json` bytes. The semantic digest of this file anchors replay and
compatibility checks.

## Mock serving

`oal serve` starts a mock that speaks Hypertext Transfer Protocol (HTTP).
The `@oal/gateway` package routes requests, validates input, emulates
authentication, and generates responses.

Contract mode serves schema-valid responses with no claimed business
behavior. Packs add static response fixtures on top of contract mode. A
stateful scenario backend is not connected in this build:

```sh
oal serve examples/quickstart.json --port 4010 --run-seed 42
```

`--mode scenario` exists as a flag but refuses to serve. The run engine has
no scenario backend to start yet, so the command exits with code `4` before
it binds a port.

The server:

- Binds to `127.0.0.1` by default. Non-loopback binding needs
  `--allow-non-loopback`.
- Prints one readiness JSON record to standard output, then no further
  standard output.
- Derives its seed from the contract, the scenario, and the run ID, unless
  you pass `--run-seed`.
- Writes a new manual-run directory under `.oal/runs/`.
- Writes synthetic credentials to a private file, or to the exact path you
  pass with `--credentials-out`.

Identical inputs and seed produce identical response bytes. `oal replay`
depends on this property. See [the quickstart](quickstart.md) for a served
request example.

## Packs

A pack is a versioned bundle. It holds a contract plus optional behavior,
fixtures, prompts, tasks, result schemas, workflows, and rubrics. The
`@oal/pack` package loads and validates packs.

The repository ships three packs:

- `packs/steel-computer` migrates the Steel v1 browser-session API. The
  manifest declares three evals and one `baseline` scenario.
- `packs/slack` is built from the Slack Web API snapshot. It ships one
  diagnostic eval in which an operator agent probes operations and authors
  response fixtures.
- `packs/webclip` is the greenfield friction-loop demonstration pack. Its
  [README](../packs/webclip/README.md) records the measured loop.

Work with packs through three commands:

```sh
oal pack init ./my-pack --openapi ./openapi.json
oal pack validate ./my-pack --strict
oal eval list ./my-pack
```

`pack init` refuses a non-empty target, copies your document unchanged, and
creates the standard directory layout. `pack validate` checks the manifest,
path safety, compilation, fixtures, prompts, schemas, and rubrics. Read
[authoring packs](authoring-packs.md) to add behavior.

## Prompts and participant material

A pack declares prompt sets. Each set renders instructions, a launch prompt,
a task, and participant files into a fresh workspace per trial. The
`@oal/runner` package renders this material before the agent starts.

The Steel pack declares two prompt sets:

- `diagnostic` tells the participant that it is under evaluation.
- `naturalistic` hides that framing.

Frozen copies land in the batch inputs:

```text
.oal/runs/<batch-id>/inputs/instructions.frozen.md
.oal/runs/<batch-id>/inputs/prompt.frozen.txt
.oal/runs/<batch-id>/inputs/task.frozen.md
```

Each trial records what the participant actually received:

```text
.oal/runs/<batch-id>/trials/<run-id>/participant-surface-manifest.json
.oal/runs/<batch-id>/trials/<run-id>/participant-surface-verification.json
```

The manifest is write-once. Verification names every discovered file and any
mismatch. It never rewrites the manifest.

## Rubrics and evaluation

An eval binds one task, one prompt set, one scenario, one result schema, and
one rubric. A rubric is a declarative list of checks. The `@oal/evaluator`
package grades runs from frozen evidence. It reads the normalized trace, the
documentation events, the final state, and the participant report. In this
build the final state stays empty: contract mode keeps no product state, so
`state.final.json` records the empty snapshot and final-state checks grade
against it.

Rubrics support these check kinds:

- `predicate`: one boolean expression.
- `event`, `documentation_event`, `semantic_event`: matching over one
  ordered stream.
- `sequence`: ordered matching with captured variables.
- `json_schema`: validation of the participant report.
- `artifact`: presence, digest, media type, or size assertion.

Expressions run in a restricted engine without file, network, time, or
process access. Arbitrary JavaScript is forbidden.

Grade a finished run or batch after the fact:

```sh
oal evaluate .oal/runs/<batch-id>
oal evaluate .oal/runs/<batch-id> --rubric ./changed-rubric.yaml
```

Evaluation verifies artifact digests first. The default uses the frozen
rubric. A supplied rubric creates a derived evaluation with a new ID. It
never overwrites the original.

Scaffold and validate a standalone eval before any paid call:

```sh
oal eval init ./my-eval --id create-issue-and-label
oal eval validate ./my-eval --strict
```

`eval init` refuses a non-empty target and writes `eval.yaml` with a minimal
task, result schema, and rubric template. `eval validate` accepts the eval
document or its directory.

## Reports and comparison

`oal report` renders a report for one run or batch. JSON output is
canonical. Terminal and Markdown are projections of it:

```sh
oal report .oal/runs/<batch-id>
oal report .oal/runs/<batch-id> --format markdown --out report.md
```

Reports keep every outcome visible. Zero-request, timed-out, agent-failed,
malformed-report, and infrastructure-invalid trials stay in the
denominators. Reports show every check numerator and denominator, operation
usage, HTTP error counts, and observed usage. Missing usage counts as
unknown, never as zero.

`oal report --regrade` creates a derived evaluation and report pair. It
records the evaluator version and the rubric digest.

`oal compare` renders two batches side by side:

```sh
oal compare .oal/runs/steel-baseline-01 .oal/runs/steel-catalog-01
```

Comparison is descriptive. It shows pass rates, denominators, exclusions,
operation usage, and Wilson intervals for binary rates. It does not pool
incompatible batches, claim significance, or select a winner. Registered
inferential comparisons require [a study](research-methods.md).

## Friction analysis

`oal friction` analyzes one run or batch for the friction the participant
experienced. It runs deterministic detectors over the recorded trace: route
mismatches, request schema rejections with their per-field pointers, media
type rejections, mock framework errors, escalation, identical retries,
abandonment, quota refusals, and reuse of mock-generated handles:

```sh
oal friction .oal/runs/<batch-id>
oal friction .oal/runs/<batch-id> --format json --out friction.json
```

Every incident names its class (`spec_friction`, `mock_fidelity`, `harness`,
`unknown`), its origin, and the evidence rows that prove it. The worklist
names the sidecar action that removes each incident: author a fixture, widen
an enum, declare a media type, normalize a route, or add a behavior backend.
Quota refusals are harness-origin and never reach the worklist.

The analysis is a measurement, not a verdict: the command exits `0`
whatever it finds. Only `--format html` and `--format markdown` are
unsupported projections. Run it again after editing the sidecar to prove
the repair: the same trials minus the repaired friction.

## Adapters

An adapter translates one normalized run context into one agent process. The
`@oal/agent-adapter` package defines the interface. Adapters never parse
contracts, build workspaces, or grade results.

This build constructs two selectors without a configuration file:

- `mock-agent`: an in-process scripted agent. It costs nothing and serves as
  the pipeline check.
- `codex-cli`: launches the Codex CLI against a model. Paid runs require
  `--yes` or an interactive confirmation.

A generic command adapter covers other local agent commands. Probe your
setup before a paid run:

```sh
oal doctor
oal doctor --agent codex-cli
```

The `codex-cli` adapter authenticates non-interactive runs with
`CODEX_API_KEY` or an `auth.json` file under `CODEX_HOME`. `CODEX_HOME`
defaults to `~/.codex`. `OPENAI_API_KEY` does not authenticate codex 0.154
non-interactively, so a run with only that variable set fails after a paid
probe. `oal doctor --agent codex-cli` reports which credential the host
provides. It prints the credential name only, never the value.

Read [the adapter API](adapter-api.md) to implement your own adapter.

## Isolation guarantees

Every trial runs inside a fresh layout that the runner creates and owns:

- A workspace outside the pack, the repository, the evidence tree, and
  sibling workspaces.
- A synthetic `HOME` and `TMPDIR` under a private control directory.
- An environment that inherits nothing by default. The pack allowlists each
  variable, such as `STEEL_BASE_URL` and `STEEL_API_KEY`.
- A per-run SQLite state database that stays private until shutdown.
- Unique synthetic credentials per run, never real secrets.
- A mock that binds one ephemeral loopback port and reaches no other
  destination.

Artifacts are immutable. `batch.json` and `run.started.json` are write-once.
Streams such as `trace.jsonl` and `lifecycle.jsonl` are append-only. Every
scope ends with an `artifact-manifest.json` of digests.

Isolation is honest, not magic. Local runs use advisory isolation when the
platform cannot enforce a network or filesystem boundary. The reported
isolation level tells you which one you got. Read [security](security.md)
for the full model, including redaction and resource limits.

## Exit codes

Every command uses one stable set of codes:

| Code | Meaning                                                     |
| ---: | ----------------------------------------------------------- |
|    0 | Success, and the evaluation threshold passed when applied.  |
|    2 | Invalid input, contract, pack, prompt, rubric, or schedule. |
|    3 | Provider or infrastructure failure.                         |
|    4 | Requested capability is unsupported.                        |
|    5 | Completed, but the evaluation threshold failed.             |
|  130 | Interrupted by `SIGINT`.                                    |
|  143 | Interrupted by `SIGTERM`.                                   |

`--no-fail-on-eval` maps code `5` to `0`. It never changes the recorded task
outcome.
