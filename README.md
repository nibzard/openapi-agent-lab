# OpenAPI Agent Lab

OpenAPI Agent Lab turns an OpenAPI document into a deterministic environment. An
AI agent can discover, call, and be evaluated against an API. The production
service is not contacted.

> Supply a local OpenAPI 3.0 or 3.1 document. Get a safe deterministic mock that
> an agent can use. Optionally attach a pack that turns interactions into a
> reproducible evaluation.

## Status

This repository holds the local implementation and the normative
specification. See [SPEC.md](SPEC.md) for the full specification (version
0.2). The hosted service that the specification describes is not built.

## What the lab does

- **Contract fidelity.** The lab compiles an OpenAPI document into routes,
  authentication rules, validators, examples, and response generators. This
  gives you a mock server with no handwritten handlers.
- **Scenario fidelity.** An optional versioned pack adds fixtures, state
  transitions, faults, tasks, and deterministic rubrics. This makes interactions
  reproducible and gradeable.
- **Exposure treatments.** The same engine serves raw HTTP, one tool per
  operation, or three catalog tools (search, describe, invoke) for large
  contracts.
- **Run engine.** Run one trial, a cohort, or a preregistered multi-cell study.
  Every run freezes its inputs, isolates the participant workspace, captures
  every request, and grades the trace and the final state.

## Install

You need Node.js 24 and pnpm 10.

1. Enable corepack:

   ```sh
   corepack enable
   ```

2. Install the workspace from the repository root:

   ```sh
   pnpm install
   ```

3. Make the `oal` command available in your shell:

   ```sh
   alias oal="node --experimental-transform-types apps/cli/src/index.ts"
   ```

   Run every `oal` command from the repository root.

## Quickstart

Run these five commands for a free end-to-end tour. The
[quickstart guide](docs/quickstart.md) explains each step.

```sh
oal inspect examples/quickstart.json
oal serve examples/quickstart.json --port 4010 --run-seed 42
oal pack validate packs/steel-computer --strict
oal run packs/steel-computer --eval basic-lifecycle --agent mock-agent
oal doctor
```

The `oal run` line exits with status `5` because the mock agent fails the
task on purpose. The guide explains the exit codes.

## Documentation

- [Quickstart](docs/quickstart.md) — run the local product end to end.
- [Usage](docs/usage.md) — a reference walkthrough of the local product.
- [Authoring packs](docs/authoring-packs.md) — add behavior, prompts, and
  rubrics to a pack.
- [Authoring studies](docs/authoring-studies.md) — write a study protocol.
- [Research methods](docs/research-methods.md) — run a preregistered study.
- [Security](docs/security.md) — isolation, credentials, and redaction.
- [Adapter API](docs/adapter-api.md) — implement an agent adapter.
- [External components](docs/external-components.md) — dependency decisions.
- [Capability matrix](docs/capability-matrix.md) — supported OpenAPI
  features.
- [SPEC.md](SPEC.md) — the complete implementation specification.

## Development

Run all gates before you propose a change:

```sh
pnpm run ci
```

The gate runs format checks, lint, type checks, package boundary checks, and
the test suite.

## License

This project is licensed under the [Apache License 2.0](LICENSE).
