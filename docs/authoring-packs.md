# Authoring packs

This document is the manifest and behavior reference for pack
authors. It describes what exists and is enforced today; the
template under `tests/fixtures/external-demo` shows every piece in
one small pack, and `docs/tutorial-external-pack.md` walks the full
loop with the installed executable.

## Pack layout

A pack is one directory with a `pack.yaml` manifest:

```text
pack.yaml                 The manifest; every other file is referenced from it.
contract/openapi.json     The OpenAPI document; operations drive the gateway.
behavior/index.ts         Scenario backend entrypoint (scenario mode).
schemas/                  State and result JSON schemas.
corpora/*.yaml            Behavioral corpora.
evals/<id>/rubric.yaml    One rubric per eval, plus a scripted participant.
prompts/<id>/             Instructions and launch text per prompt set.
tasks/<id>/task.md        One task per eval.
fidelity/claims.json      The fidelity declaration.
```

`oal pack init DIRECTORY --openapi DOC` scaffolds the contract-mode
shape; the scenario fields below turn it into a stateful pack.

## Manifest sections

The manifest validates against `pack.v1`. The stateful sections:

- `behavior.mode: scenario` with `behavior.backend` naming a module
  entrypoint and export. The backend owns domain state and side
  effects; the gateway routes requests to it.
- `behavior.state_schema` names a JSON schema the committed state
  must satisfy on every write.
- `behavior.clock.kind: virtual` with an initial instant and tick:
  the world owns time, so `advance_time` moves TTLs and waits
  without sleeping.
- `corpora` lists the corpora by id and source path.
- `fidelity.source` names the fidelity claims document.
- `scenarios` lists scenario ids the evals may select.
- `security` declares the credential alternatives; a contract with
  a security scheme makes the world mint credentials for trials.
- `participant.environment.allow` lists the environment variables a
  participant may see.

## The behavior backend

The backend module exports a `backend` object of backend API
version 1 (from `@oal/behavior-api`):

- `create(context)` receives the compiled contract and returns the
  backend.
- `describe()` declares operation support and the semantic events
  with their payload schemas.
- `initialize(context)` returns the first state; the deterministic
  clock, id, random, and blob services arrive here.
- `handle(request, context)` answers one request and may return a
  next state and semantic events.

Two rules are enforced. The module must stay erasable-syntax
TypeScript: it runs under Node type stripping, so enums and
namespaces are out. And it may import only `@oal/behavior-api` and
`@oal/behavior-runtime` by package name plus relative files inside
the pack: dynamic imports, require calls, escaping paths, and
ambient dependencies are refused before any child starts, and every
file the entrypoint reaches is frozen and hashed, so a later edit
cannot change a running world's behavior identity.

## Behavioral corpora

A corpus is a YAML document with an id, a scenario, typed inputs,
and fixed cases. Each case carries `claim_ids`, a `scope`, and
ordered steps:

- A request step names an operation id, literal or referenced
  parameters, an optional body, `bind` captures by JSON Pointer,
  and `assert` entries (`status`, `exists`, `equals`, `not_equals`,
  `contains`, `length`, `matches_schema`).
- An operator step drives the world: `reset`, `inspect`,
  `checkpoint`, `fork`, `advance_time`, or `install_fault`. Operator
  steps belong to `emulator_only` scope; provider targets skip
  those cases before setup and never count them as passes.

`oal corpus run` executes one corpus; `oal corpus verify` runs it
on the local target and then the provider, and records a skip —
never a pass — while credentials are missing.

## Fidelity claims

The claims document names the provider, the API version, and one
claim per behavioral promise. Every claim carries a
classification:

- `documented`: stated by the provider's documentation, with the
  source URL and retrieval date.
- `observed`: seen in a recorded provider run, stamped with the
  verification date and the report digest.
- `synthetic`: true of the local emulator by construction; no
  provider observation can upgrade it.
- `unsupported`: believed false or unknown for this surface.

The upgrade is manual by design: `oal corpus verify` writes the
stamped observed claims as a review artifact, and a human review
promotes them into the pack with a commit.
