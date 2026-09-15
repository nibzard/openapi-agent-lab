# OpenAPI Agent Lab

OpenAPI Agent Lab turns an OpenAPI document into a deterministic environment. An
AI agent can discover, call, and be evaluated against an API. The default
commands are offline: the production service is not contacted. The one
exception is `oal probe`, which replays recorded requests against a live base
URL that you name.

> Supply a local OpenAPI 3.0 or 3.1 document. Get a safe deterministic mock that
> an agent can use. Optionally attach a pack that turns interactions into a
> reproducible evaluation.

## Status

This repository holds the local implementation and the normative
specification. See [SPEC.md](SPEC.md) for the full specification (version
0.2). The hosted service that the specification describes is not built.

The execution surface splits into three states:

- **Working end to end.** Raw HTTP execution: `oal inspect`, `oal serve` in
  contract mode, `oal run --exposure raw-http` with the mock, generic, or
  Codex adapter, plus `oal evaluate`, `oal report`, `oal compare`,
  `oal replay`, `oal friction`, `oal probe`, and `oal doctor`. Scenario
  execution works through `oal run` for packs with a behavior module: the
  runner drives the stateful backend, records committed state and semantic
  events, and grades the errand. Study authoring works through
  `oal study init`, `validate`, and `schedule`, and `oal study analyze` runs
  the frozen analysis on an assembled study-run directory.
- **Implemented components, not connected.** The direct-tool and
  catalog-tool surfaces and the study scheduler exist as tested packages.
  The run commands do not drive them yet.
- **Refused by the command-line interface.** `oal serve --mode scenario`,
  `oal run --exposure direct-tools|catalog-tools`, and participant launch in
  `oal study run` exit with code `4` and a diagnostic. The
  [review fix plan](docs/review-fix-plan.md) tracks the work that connects
  them.

## What the lab does

- **Contract fidelity.** The lab compiles an OpenAPI document into routes,
  authentication rules, validators, examples, and response generators. This
  gives you a mock server with no handwritten handlers.
- **Scenario fidelity.** An optional versioned pack adds response fixtures,
  tasks, result schemas, deterministic rubrics, and a behavior module with
  stateful operations. `oal run` executes such packs through the behavior
  runtime; `oal serve` stays in contract mode and serves deterministic but
  stateless responses.
- **Exposure treatments.** Raw HTTP is the one exposure the run engine
  serves today. Direct-tool and catalog-tool components exist in
  `@oal/tools`; the runner refuses runs that request them until the bridge
  lands.
- **Run engine.** Run one trial or a cohort. Every run freezes its inputs,
  isolates the participant workspace, captures every request, and grades the
  trace and the participant report. Study runs stop at validation and
  scheduling; no command launches study participants yet.

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
- [Authoring packs](docs/authoring-packs.md) — placeholder; not written yet.
- [Authoring studies](docs/authoring-studies.md) — placeholder; not written
  yet.
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
