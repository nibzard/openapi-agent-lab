# Quickstart

This guide runs the local product end to end on your machine. An OpenAPI
document describes one application programming interface (API). You inspect
the document, serve a deterministic mock of the API, and run an evaluated
trial. You also replay the trial and check your tool prerequisites. No call
reaches a live service and no call costs money.

## Before you start

You need:

- The repository checked out.
- Node.js 24 (any 24.x release).
- pnpm 10, enabled through corepack.
- A POSIX shell. The commands in this guide use POSIX syntax.

## Install the workspace

1. Change into the repository root. Keep this directory as your working
   directory for every command in this guide.
2. Enable corepack and install the workspace:

   ```sh
   corepack enable
   pnpm install
   ```

3. Check the install:

   ```sh
   node --version
   ```

   The command must print a version that starts with `24`.

## Make the oal command available

The command line interface (CLI) is the `oal` command. It runs from TypeScript
source, so it needs no build step. Define a shell alias:

```sh
alias oal="node --experimental-transform-types apps/cli/src/index.ts"
```

Node prints a one-line experimental warning on standard error. The warning is
harmless. Add the alias to your shell profile to keep it.

Run `oal help` now. It lists every command. Run `oal help <command>` for one
command, for example `oal help run`.

## Inspect a contract

1. Inspect the example contract:

   ```sh
   oal inspect examples/quickstart.json
   ```

2. Read the report. It prints the entrypoint, the media type, the SHA-256
   digest, and the size in bytes of the source document:

   ```text
   entrypoint: /abs/path/examples/quickstart.json
   media_type: application/json
   sha256: 7f14f625f4ddb297405f9f73cac2b9c5c2c413fa96cb50b7c25a77df65db60bb
   bytes: 10293
   ```

3. Add `--json` when you want machine-readable output:

   ```sh
   oal inspect examples/quickstart.json --json
   ```

## Serve the mock API

The example contract declares one bearer security scheme. The mock enforces
it, so a plain request fails. The server writes the synthetic credential to a
file you choose with `--credentials-out`.

1. Start the server:

   ```sh
   oal serve examples/quickstart.json \
     --port 4010 \
     --run-seed 42 \
     --credentials-out ./quickstart-creds.json
   ```

2. Wait for the readiness record. The server prints one record in JavaScript
   Object Notation (JSON) to standard output, then stays quiet. The record
   names the base URL, the run ID, the operation count, and the credentials
   path.

3. Open a second terminal in the repository root. Send a request without a
   token:

   ```sh
   curl -i http://127.0.0.1:4010/notes
   ```

   The mock responds with status `401`. The contract requires a bearer token.

4. Read the synthetic token from the credentials file:

   ```sh
   TOKEN=$(node -p \
     'JSON.parse(require("node:fs").readFileSync("quickstart-creds.json","utf8")).alternatives[0].schemes[0].value')
   ```

   Each scheme entry carries its synthetic value in the `value` field. Print
   the file with `cat quickstart-creds.json` to see every field. The file
   holds synthetic values only. It is never part of the evidence.

5. Send an authenticated request:

   ```sh
   curl -i http://127.0.0.1:4010/notes \
     -H "Authorization: Bearer $TOKEN"
   ```

   The mock responds with status `200` and a generated notes list. The same
   `--run-seed` value always produces the same response bytes.

6. Stop the server with `Ctrl+C` in the first terminal.

The server binds to `127.0.0.1` only. It writes evidence for the manual run
under `.oal/runs/`. A rerun with the same seed serves identical responses.

## Validate the built-in pack

1. Validate the Steel Computer pack:

   ```sh
   oal pack validate packs/steel-computer --strict
   ```

2. Read the summary. It prints the pack ID, the manifest digest, the behavior
   mode, and the operation, eval, and scenario counts:

   ```text
   pack: steel-computer
   manifest: pack.yaml
   manifest_sha256: 63bd08c7dcd92390d413f0aa09dac372c20f68b9…
   behavior_mode: contract
   operations: 41
   evals: 3
   scenarios: 1
   ```

   The digest is longer than one line in this guide. Your terminal prints it
   in full.

3. List the evals the pack declares:

   ```sh
   oal eval list packs/steel-computer
   ```

## Run an evaluated trial

Run the `basic-lifecycle` eval with the built-in mock agent. Pass an explicit
batch ID so the output paths stay short:

```sh
oal run packs/steel-computer \
  --eval basic-lifecycle \
  --agent mock-agent \
  --batch demo-01
```

The mock agent runs a fixed empty script. It starts no model and costs
nothing. It proves that the runner, the evidence store, and the evaluator
work on your machine. The command prints the batch ID, the absolute batch
directory, the manifest digest, and one disposition line per trial:

```text
batch: demo-01
batch dir: /abs/path/.oal/runs/demo-01
manifest sha256: 6a8e114e629794c47ef2cd2bba43e6997f45d03e…
run demo-01-run-01: agent_incomplete (OAL-RUN-DISPOSITION-AGENT-INCOMPLETE) censor=none
evaluation threshold failed; rerun with --no-fail-on-eval to map 5 to 0
```

Without `--batch`, the batch ID derives from the UTC start time. The digest
is longer than one line in this guide.

The trial ends with disposition `agent_incomplete`. This outcome is correct.
The mock agent sends no requests and writes no final report, so the task
cannot complete. The rubric grades the trial as failed, so the command exits
with status `5`. Status `5` means the harness worked and the evaluation
threshold failed. Add `--no-fail-on-eval` when you want status `0` anyway.

To run a real trial against a model, use the Codex CLI adapter:

```sh
oal run packs/steel-computer \
  --eval basic-lifecycle \
  --agent codex-cli \
  --model MODEL_ID \
  --effort high \
  --count 1 \
  --yes
```

Replace `MODEL_ID` with your model identifier. Paid runs ask for confirmation
unless you pass `--yes`. Add `--dry-run` to see the full plan, including the
paid-call ceiling, before any money is spent:

```sh
oal run packs/steel-computer --eval basic-lifecycle --agent codex-cli --dry-run
```

## The run directory

Every batch writes an immutable directory under `.oal/runs/<batch-id>/`. The
layout below shows the files you will read most often:

```text
.oal/runs/<batch-id>/
  batch.json                     Immutable batch header
  inputs/                        Frozen inputs
    pack.frozen.yaml             Pack bytes at run time
    contract.ir.json             Compiled contract
    capability-report.json       Support assessment
    run-profile.frozen.yaml      Adapter, model, limits, count
    prompt.frozen.txt            Participant launch prompt
    instructions.frozen.md       Participant instructions
    task.frozen.md               Task text
    result-schema.frozen.json    Result contract
    rubric.frozen.yaml           Grading rules
  trials/<run-id>/               One directory per trial
    run.started.json             Write-once start record
    run.completed.json           Completion pointer
    lifecycle.jsonl              Append-only lifecycle stages
    server.json                  Mock server record
    state.final.json             Final backend state
    participant-report.json      Final agent output
    evaluation.json              Grading result
    resource-usage.json          Observed usage
    artifact-manifest.json       Digests for every payload
    session/                     Redacted agent output
    workspace/                   Sanitized workspace snapshot
    blobs/                       Content-addressed objects
  cohort-evaluation.json         Aggregate grading
  report.json                    Canonical report
  artifact-manifest.json         Batch-level digests
  batch.completed.json           Completion pointer
```

Files that a trial could not produce stay absent. The run completion record
names each expected missing artifact with a reason. No file is fabricated as
an empty placeholder.

## Replay the run

Replay sends the recorded requests to a reconstructed mock. It starts no
agent and costs nothing.

1. Find the run directory. Use the batch directory printed by `oal run`:

   ```sh
   ls .oal/runs/demo-01/trials
   ```

2. Replay every recorded request:

   ```sh
   oal replay .oal/runs/demo-01/trials/demo-01-run-01
   ```

3. Verify that the mock still reproduces the record:

   ```sh
   oal replay .oal/runs/demo-01/trials/demo-01-run-01 --verify
   ```

   In verify mode, a difference from the record is an error. The command then
   exits with status `2`.

4. Replay one request only:

   ```sh
   oal replay .oal/runs/demo-01/trials/demo-01-run-01 --request 1
   ```

A mock-agent trial records no requests, so its replay covers zero requests
and exits with status `0`. Replace `demo-01` with your own batch ID. Each
recorded request is classified `full`, `substitutable`, or `unavailable`.

## Check local prerequisites

Run the doctor before you configure an adapter:

```sh
oal doctor
```

Doctor checks the Node version, the workspace packages, the SQLite state
store, the schema files, and the limits table. It also probes the adapter,
the gateway determinism, and the artifacts directory.

Doctor reports platform capabilities separately. These cover loopback
ephemeral ports, file permissions, process-group termination, network
isolation, sandbox mechanisms, and container runtimes. It makes no paid model
call.

Pass a selector to probe a specific adapter:

```sh
oal doctor --agent codex-cli
```

## Where to go next

- [Usage](usage.md): a reference walkthrough of the local product.
- [Authoring packs](authoring-packs.md): add scenarios, prompts, and rubrics.
- [Authoring studies](authoring-studies.md): preregister a multi-cell study.
- [Security](security.md): the isolation and redaction model.
- [Capability matrix](capability-matrix.md): supported OpenAPI features.
