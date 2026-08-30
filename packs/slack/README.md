# Pack slack

This pack was scaffolded by `oal pack init` in contract mode.

## Contract fidelity

In contract mode the mock answers only from the OpenAPI document: declared
examples, schemas, and response selectors. It claims no business semantics. Use
it when the question is whether a participant can read and apply a contract.

## Scenario fidelity

In scenario mode the pack supplies a behavior backend that owns domain state
and side effects. Switch by setting `behavior.mode: scenario`, declaring a
`behavior.backend`, and adding fixtures under `fixtures/`. Scenario mode is
required when the eval depends on state, idempotency, or semantic events.

## Layout

| Directory    | Purpose                                       |
| ------------ | -------------------------------------------- |
| contract/    | The copied OpenAPI document                   |
| behavior/    | Scenario backend entrypoint                   |
| fixtures/    | Initial state and response fixtures           |
| prompts/     | Prompt set instructions and launch text       |
| tasks/       | Task documents materialized as TASK.md        |
| schemas/     | Result and payload schemas                    |
| evals/       | Rubrics and eval-specific material            |
| workflows/   | Arazzo workflows                              |
| tests/       | Response conformance tests declared by you    |

Validate with `oal pack validate <this-directory>`.
