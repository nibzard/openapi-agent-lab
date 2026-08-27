# OpenAPI Agent Lab

OpenAPI Agent Lab turns an OpenAPI document into a deterministic environment. An AI agent can discover, call, and be evaluated against an API. The production service is not contacted.

The lab exists to answer one question:

> **Can an agent discover and understand our product through the API server itself?**

The lab measures how agent-friendly an API design is. The measurements drive a better design. See [Refine your API design from agent sessions](#refine-your-api-design-from-agent-sessions).

> Supply a local OpenAPI 3.0 or 3.1 document. Get a safe deterministic mock that an agent can use. Optionally attach a pack that turns interactions into a reproducible evaluation.

## Status

This repository holds the implementation specification only. No code is included yet. See [SPEC.md](SPEC.md) for the full normative specification (version 0.2).

## What the lab does

- **Contract fidelity.** The lab compiles an OpenAPI document into routes, authentication rules, validators, examples, and response generators. This gives you a mock server with no handwritten handlers.
- **Scenario fidelity.** An optional versioned pack adds fixtures, state transitions, faults, tasks, and deterministic rubrics. This makes interactions reproducible and gradeable.
- **Exposure treatments.** The same engine serves raw HTTP, one tool per operation, or three catalog tools (search, describe, invoke) for large contracts.
- **Run engine.** Run one trial, a cohort, or a preregistered multi-cell study. Every run freezes its inputs, isolates the participant workspace, captures every request, and grades the trace and the final state.

## How it works

```text
          OpenAPI 3.0/3.1 doc                     optional scenario pack
                   │                                        │
                   └──────────────────┬─────────────────────┘
                                      ▼
                               ┌─────────────┐
                               │   compile   │  ContractIR
                               │             │  + capability report
                               └──────┬──────┘
                                      ▼
  ┌─────────────────┐        ┌─────────────────────────┐
  │      agent      │        │    deterministic mock   │
  │  Codex CLI or   │───────►│    HTTP · tools · MCP   │
  │  any argv CLI   │        │       on loopback       │
  └─────────────────┘        └────────────┬────────────┘
                                          │ every request kept:
                                          │ accepted + rejected
                                          ▼
                               ┌─────────────────────────┐
                               │   normalized evidence   │
                               │    trace + final state  │
                               └────────────┬────────────┘
                                            │
                          ┌─────────────────┴─────────────────┐
                          ▼                                   ▼
                  ┌───────────────┐                   ┌───────────────┐
                  │   evaluator   │                   │    reports    │
                  │ deterministic │                   │ JSON · term · │
                  │    rubrics    │                   │   Markdown    │
                  └───────────────┘                   └───────────────┘
```

One engine serves every treatment. The compiler turns the document into a single ContractIR. The mock exposes the contract on loopback. The agent reaches it through an adapter. The gateway records every request that arrives, accepted or rejected. The evidence is normalized, so the evaluator and the report builder always see the same facts.

## Refine your API design from agent sessions

```text
  ┌────────────┐  serve   ┌────────────┐   run task   ┌─────────────┐
  │ draft spec │─────────►│    mock    │─────────────►│    agent    │
  └─────▲──────┘          └────────────┘              └──────┬──────┘
        │                                                    │
        │                              every request kept,   │
        │                              accepted + rejected   │
        │                                                    ▼
        │                               ┌─────────────────────────┐
        │        revise the spec        │   analyze the session   │
        └───────────────────────────────│   trace + final state   │
                                        └─────────────────────────┘
```

The lab is not only a test harness. It is also a design tool. You do not need a production service to learn how an API behaves in the hands of an agent. The loop below is how the driving question at the top gets answered in practice: the session shows what the agent could discover, what it misunderstood, and what it never found. Use the loop to flesh out the final API design before you write the server. Start with [examples/quickstart.json](examples/quickstart.json) if you want to try the loop before you write your own document:

1. Write a draft OpenAPI document.
2. Start the mock: `oal serve ./openapi.json`.
3. Point a coding agent at it. Codex CLI uses the built-in adapter. Claude Code and other CLI agents use the generic argv adapter.
4. Give the agent a task that a real user of the API must do.
5. Read the session with `oal report`.

The gateway keeps every request. Accepted and rejected requests are both kept. Requests to routes that do not exist are also kept. This gives design feedback that is hard to get in any other way:

- Calls to routes that do not exist tell you that agents expect a resource that the document does not name well, or does not contain.
- Repeated retries tell you that a parameter, a serializer, or an error body is hard to get right.
- A long path of discovery calls tells you that operation names and descriptions do not lead the agent to the correct call.

Change the document. Run the session again. When the agent reaches the task goal with a short trace and few rejected requests, the design is ready for review. The final API design is then based on observed agent behavior, not on opinion.

## Documentation

- [SPEC.md](SPEC.md) — the complete implementation specification.
- [examples/](examples/) — starter contracts: a hand-written quickstart, the Steel Browser API, and the E2B API.

## License

This project is licensed under the [Apache License 2.0](LICENSE).
