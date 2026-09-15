# Security

This document describes the local security model. It covers what the product
protects, how isolation works, and where the guarantees end. The normative
source is specification sections 28 through 31.

## Security model

The product treats every input as untrusted until validated. Untrusted inputs
include:

- OpenAPI documents and imported packs.
- Descriptions, examples, defaults, and extension values inside them.
- Prompts, tasks, and rubric templates.
- Agent and model output.
- Agent-generated HTTP requests and tool calls.

The default system prevents these inputs from:

- Executing commands on the host through mock semantics.
- Reading or writing arbitrary host paths.
- Contacting a production API or any other destination.
- Resolving unapproved references.
- Accessing provider or ambient credentials.
- Accessing the state, trace, or artifacts of another run.
- Causing unbounded CPU, memory, disk, process, request, or token use.
- Placing secrets in exported evidence.

The controller, the gateway, and the state store form the trusted computing
base. Each is scoped to one run.

## What the local product refuses to do

The initial local release excludes, by design:

- Forwarding to a production service. The mock never falls back to upstream
  traffic.
- Real cloud or software-as-a-service credentials.
- Host command execution triggered by API payloads.
- Fetching URLs named in a contract, callback, webhook, or link.
- Invoking callbacks or webhooks.
- Real browser, desktop, SSH, email, payment, or infrastructure effects.
- Remote references during a run.
- Binding to a public address by default.
- Running untrusted third-party behavior in-process.
- A model judge as the primary grader.

## Network policy

The mock and the participant obey a deny-by-default network policy:

- The mock binds to `127.0.0.1` only. Trials request an ephemeral port.
- Binding to another address requires `--allow-non-loopback` plus explicit
  local configuration.
- The mock and the behavior runtime make no outbound connection.
- URL upload, redirect, callback, webhook, and link targets are never opened.
- Remote references are rejected at ingestion, without any retrieval attempt.
- Readiness and admin channels use private files or sockets, never a
  participant-visible endpoint.

Every effective server URL is rewritten before the participant sees the
contract. An agent that tries to reach the named production server cannot
resolve it through the mock. The `@oal/gateway` package enforces these rules.

### Operator-authorized live probing

`oal probe` is the one operator-initiated exception to the offline default.
The commands above never send traffic on their own. A probe sends recorded
requests to the base URL you pass in `--base-url`, and it sends a real
credential from the environment variable you name in `--credential-env`.

The default mode replays GET, HEAD, and OPTIONS requests only. Other methods
replay after you pass `--allow-writes`. A redirect stays manual, so a 3xx
compares as a status and a write is never re-issued. The credential value is
registered as a run secret before anything is written. See
[usage](usage.md#live-conformance-probe) for the full command behavior.

## Filesystem and workspace policy

Each trial receives distinct roots for inputs, workspace, output, state,
evidence, and temporary files. The `@oal/runner` package creates and owns
these roots:

- Local directories default to mode `0700`. Sensitive files default to mode
  `0600`.
- Artifact paths are created exclusively. An existing path is refused.
- API paths stay virtual. The gateway never resolves a request path against
  the host filesystem.
- Pack paths cannot be absolute or traverse out of the pack root.
- Participant input contains only declared, sanitized files.
- State and evidence stay invisible to the participant.
- Cleanup targets only validated per-run roots. It never accepts a home,
  project, or filesystem root.
- Workspace archives keep symlinks as inert entries and never dereference
  them.

## Credentials

The product separates three credential classes:

1. **Provider credentials.** These stay with the controller. They never enter
   the participant environment or any artifact.
2. **Run API credentials.** Each run mints unique synthetic values that
   satisfy the contract security schemes.
3. **Scenario fixture secrets.** Packs may declare synthetic values for
   safe-handling tasks.

The `@oal/gateway` package mints run credentials from the contract security
schemes. Each value is a domain-separated SHA-256 digest of the run seed, so
replay regenerates identical values. Values use the `oal_` prefix and look
like `oal_4f13c9d2...`. They are unmistakably synthetic.

Credential delivery follows fixed rules:

- The participant environment inherits nothing by default.
- Only the pack-allowlisted variables are injected, such as `STEEL_BASE_URL`
  and `STEEL_API_KEY`.
- Credentials never appear in argv, readiness output, logs, or evidence.
- Manual serving writes credentials to one private file with mode `0600`.
  Use `--credentials-out` to choose the path. The file is deleted when the
  server finalizes.
- Real production credentials are forbidden in contract and scenario modes.

Ingestion scans source documents for high-confidence secrets before freezing
or copying them. A finding fails the run with code
`OAL-INPUT-SECRET-DETECTED` and a source pointer. The value itself is never
repeated in the diagnostic.

## Redaction

Redaction runs before ordinary persistence and telemetry. The `@oal/evidence`
package owns the pipeline. It combines:

- Locations derived from the contract security schemes.
- An exact-value registry of every run secret.
- Pack configuration for sensitive headers, cookies, query keys, path
  parameters, and JSON Pointers.
- Key patterns for names such as `authorization`, `token`, `secret`, and
  `password`.
- Defensive recognition of bearer, basic, token-shaped, and private-key
  values.
- The pack annotation `x-agent-lab-sensitive: true`.

Redaction covers every artifact class:

- Request and response headers, cookies, and query strings.
- Bodies in every supported media type.
- Mock state and its projections.
- Session events, standard output, and standard error.
- The participant report.
- Diagnostics, metrics, and the archived workspace.

Where structure permits, a redacted value is recorded as:

```json
{
  "redacted": true,
  "kind": "bearer_token",
  "fingerprint": "hmac-sha256:4f13c9d2"
}
```

The fingerprint uses a run-specific keyed hash, never a plain digest. Text
contexts use `[REDACTED]`.

Unredacted capture is disabled by default. Canary tests register unique
secrets in every supported location and assert that none appear in any
artifact. A leak is a release-blocking failure.

## Resource limits

The `@oal/config` package owns the limits table. The gateway enforces it.
Every limit is configurable downward. Selected defaults and local ceilings:

| Resource                | Default      | Ceiling       |
| ----------------------- | -----------: | ------------: |
| Source OpenAPI bytes    | 10 MiB       | 25 MiB        |
| Parsed nodes            | 100,000      | 250,000       |
| Operations              | 5,000        | 10,000        |
| Request body            | 5 MiB        | 25 MiB        |
| Generated response body | 10 MiB       | 25 MiB        |
| Requests per run        | 10,000       | 100,000       |
| Burst rate              | 100/second   | 1,000/second  |
| Persisted state         | 100 MiB      | 500 MiB       |
| All artifacts per run   | 1 GiB        | 5 GiB         |
| Trial wall time         | 30 minutes   | 60 minutes    |
| Batch trials            | 1            | 100           |
| Parallel trials         | 1            | 10            |
| Schema worker deadline  | 1 second     | 30 seconds    |
| Schema worker processes | 2            | 8             |
| Schema worker queue     | 128 pending  | 1,024 pending |
| Schema worker message   | 8 MiB        | 32 MiB        |
| Schema worker memory    | 256 MiB      | 1 GiB         |

Parsing controls bound YAML alias expansion, reference depth, duplicate keys,
regex evaluation, and XML entity expansion. At runtime, the gateway rejects
overload explicitly. It returns `413` for an oversized body and `414` for an
oversized target. It returns `429` when a quota is exceeded. Validation
always runs before any state mutation. A limit event stays visible in the
evidence.

## Schema and pattern evaluation boundary

Every regular expression that comes from, or is checked against, untrusted
data runs inside a bounded worker pool. The `@oal/core` package owns the
pool. Each worker is a separate process with a deadline, a queue bound, a
message-size bound, and a memory bound. The five schema-worker limits in the
table above control the pool.

Untrusted data means both operands:

- The pattern, from a contract, pack, or study document.
- The tested value. A fixed schema plus an adversarial value can backtrack
  just as hard as an adversarial pattern. First-party schemas that validate
  untrusted documents also run inside the boundary.

The following surfaces evaluate inside the boundary:

- Gateway request validation, response validation, and response generation.
- Path-parameter pattern checks and pattern synthesis. The gateway collects
  pattern strings per path family in the serving process, but every
  execution of those strings happens in a worker.
- Evaluator checks: rubrics, eval documents, result schemas.
- Pack validation: manifests, prompt sets, eval entries, semantic event
  registries, and the built PackIR.
- Contract-variant loading: sets, manifests, and diffs.
- Study loading: protocol, phases, compile, lock, and review documents.
- Cue forbidden-text scans.

A deadline produces code `OAL-SCHEMA-WORKER-TIMEOUT`. The gateway maps it to
a `504` infrastructure outcome, rolls back the open transaction, and
replaces the worker. No state mutation survives a timeout. A message above
the size bound produces `OAL-SCHEMA-WORKER-MESSAGE-TOO-LARGE`. A full queue
produces `OAL-SCHEMA-WORKER-QUEUE-FULL`.

### Pattern inventory: what still runs in the serving process

These sites compile or execute patterns outside the worker. Each one is safe
for a stated reason:

| Site                                | Why it stays in the serving process            |
| ----------------------------------- | ---------------------------------------------- |
| `@oal/core` credential key pattern  | Fixed first-party literal.                     |
| `@oal/gateway` parameter parsing    | Fixed first-party literals.                    |
| `@oal/runner` cue pattern compile   | Compile check only. Execution runs in a worker. |
| `@oal/contract-variant` description | The untrusted label is escaped before use.     |
| First-party schema literals         | Fixed patterns shipped with the repository.    |

One latent site remains. `@oal/agent-adapter` validates agent session events
against a schema document and compiles the schema's patterns in process. No
production path calls it today. Route it through the boundary before it
gains a production caller.

## Isolation honesty

Local isolation is advisory unless the platform can enforce it. The product
reports the level it actually reached. It never claims enforcement that did
not happen.

Specifically:

- A third-party agent CLI runs as your operating system user. It can inspect
  files and spawn descendants unless an enforced boundary exists.
- If the adapter cannot separate provider connectivity from agent command
  egress, the reported isolation level is partial or advisory.
- A strict blinding policy under advisory isolation produces an explicit
  warning. The `@oal/runner` surface check emits it.
- `oal doctor` reports which sandbox, network-isolation, and
  process-termination mechanisms it could verify on your machine.

Use a container, a microVM, or a separate operating system account when you
need an enforced boundary. Pack behavior code runs in a separate restricted
process through the `@oal/behavior-runtime` package, with bounded
communication and no network.

Prompt instructions, environment filtering, and a synthetic `HOME` are real
controls. They are not a security boundary against a malicious agent CLI
running as the same user.
