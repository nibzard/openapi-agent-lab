# OpenAPI Agent Lab

Build reproducible environments for testing agents against application
programming interfaces (APIs). Run a stateful workflow, inspect its effects,
and fork the world to test another approach.

An OpenAPI document gives you a generated mock. A pack adds domain behavior
and task grading. Stateful packs keep changes between requests: later calls
can read, change, or delete resources you created. You define that behavior
in the pack.

## Try a successful run

You need Node.js 24, pnpm 10, and Bash or Zsh. Run these commands from the
repository root. World controls require Unix domain sockets.

```sh
corepack enable
pnpm install

oal() { node --experimental-transform-types apps/cli/src/index.ts "$@"; }
```

Run the included Webclip task with a scripted participant:

```sh
oal run packs/webclip \
  --eval site-errand \
  --agent mock-agent \
  --agent-script packs/webclip/evals/site-errand/mock-participant.json
```

The participant creates clips, renders and extracts content, then deletes one clip.
It uses no model or live service. Expect `completed` and exit code `0`.

The command prints the batch directory under `.oal/runs/`. In its
`trials/<run-id>/` directory, inspect:

- `state.final.json`: six committed changes and the remaining clip.
- `semantic-events.redacted.jsonl`: the six lifecycle events.
- `evaluation.json`: the task score, which is `1` for this script.

See the [quickstart](docs/quickstart.md) for requests and agent configuration.

## Check the behavior

A behavioral corpus tests requests and their effects. Each case gets a fresh local world:

```sh
oal corpus run packs/webclip --corpus webclip-core \
  --input essay_url=https://example.com/essay \
  --input dashboard_url=https://example.com/dashboard \
  --out .oal/webclip-corpus.json
```

All seven cases should pass. They check resource relationships, deletion, quota,
operation ordering, and content representations. The
[external pack tutorial](docs/tutorial-external-pack.md) demonstrates a detected defect.

The lab keeps these results separate:

| Result | What it establishes |
| --- | --- |
| Contract conformance | Requests and responses match the declared interface. |
| Behavioral conformance | The target passes the corpus assertions. |
| Agent task success | The participant meets the task's grading rules. |

Service fidelity requires checking the modeled behavior against a real service.

## Serve and fork a world

Start Webclip as a local server in one terminal:

```sh
oal serve packs/webclip --mode scenario --run-id webclip-world --port 4010
```

The server prints a readiness record and stays in the foreground.
In a second terminal, open the repository root and define `oal` again.
Take a checkpoint, then start a fork:

```sh
oal world checkpoint --world .oal/control/serve/webclip-world \
  --out .oal/checkpoints/webclip-start

oal world fork .oal/checkpoints/webclip-start \
  --out .oal/worlds/webclip-fork --port 4011
```

The fork continues the checkpoint's state, identifiers, random streams, and virtual time.
Each world has separate credentials, listed in its readiness record.
Stop each server with `Ctrl+C`. Use new run identifiers and directories for repeat runs.

Reset and virtual-time controls use a separate private operator socket.
See [operator controls](docs/usage.md#operator-controls) for the protocol.

## What works today

| Capability | Status |
| --- | --- |
| Generated mocks from OpenAPI 3.0 and 3.1 | Available through `oal serve`. |
| Stateful worlds and checkpoint forks | Available through scenario serving and world commands. |
| Behavioral corpora | Local execution works; the GitHub target requires explicit permission for live writes. |
| Agent evaluation | Mock, generic command, and Codex adapters are connected to the runner. |
| Study tooling | Authoring, validation, scheduling, and analysis work; participant launch is unavailable. |
| Direct-tool and catalog-tool execution | Components exist; the runner refuses these exposure modes. |

`oal probe` contacts the live URL you provide. GitHub corpus runs and verification
can also contact a live service. Model adapters can incur charges.

## Current limits

Webclip is a synthetic reference pack. The GitHub issue-triage pack has eight
core cases that pass locally, but live provider verification remains pending.
Practitioner trials also remain pending, so the stateful milestone is incomplete.

Behavior modules run as trusted local code. The behavior child is not sandboxed;
use packs you trust. The hosted service is not built.

See [stateful limitations](docs/stateful-limitations.md) for compatibility and
remaining work, and [security](docs/security.md) for isolation and credentials.

## Documentation

- [Usage](docs/usage.md): commands and world controls.
- [Authoring packs](docs/authoring-packs.md): behavior modules, tasks, and rubrics.
- [External pack tutorial](docs/tutorial-external-pack.md): build and test a pack outside this repository.
- [Adapter API](docs/adapter-api.md): connect an agent.
- [Capability matrix](docs/capability-matrix.md): supported OpenAPI features.
- [Research methods](docs/research-methods.md): study design and analysis.
- [SPEC.md](SPEC.md): the normative implementation specification.

## Development

Run all checks before proposing a change:

```sh
pnpm run ci
```

This runs formatting, lint, type checks, package boundary checks, and tests.
`pnpm run readiness:stateful` reports the remaining milestone requirements.

## License

[Apache License 2.0](LICENSE).
