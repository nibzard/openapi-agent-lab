# OpenAPI Agent Lab

OpenAPI Agent Lab turns an OpenAPI document into a deterministic environment. An AI agent can discover, call, and be evaluated against an API. The production service is not contacted.

> Supply a local OpenAPI 3.0 or 3.1 document. Get a safe deterministic mock that an agent can use. Optionally attach a pack that turns interactions into a reproducible evaluation.

## Status

This repository holds the implementation specification only. No code is included yet. See [SPEC.md](SPEC.md) for the full normative specification (version 0.2).

## What the lab does

- **Contract fidelity.** The lab compiles an OpenAPI document into routes, authentication rules, validators, examples, and response generators. This gives you a mock server with no handwritten handlers.
- **Scenario fidelity.** An optional versioned pack adds fixtures, state transitions, faults, tasks, and deterministic rubrics. This makes interactions reproducible and gradeable.
- **Exposure treatments.** The same engine serves raw HTTP, one tool per operation, or three catalog tools (search, describe, invoke) for large contracts.
- **Run engine.** Run one trial, a cohort, or a preregistered multi-cell study. Every run freezes its inputs, isolates the participant workspace, captures every request, and grades the trace and the final state.

## Documentation

- [SPEC.md](SPEC.md) — the complete implementation specification.

## License

This project is licensed under the [Apache License 2.0](LICENSE).
